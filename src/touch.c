/*
 * Mai Pico Touch Keys
 * WHowe <github.com/whowechina>
 *
 * The touch decision is done in software from the MPR121 filtered readings:
 *   delta = baseline - filtered   (a touch lowers the filtered value)
 * A zone turns active when its delta crosses an absolute per-zone threshold,
 * with hysteresis and a debounce count. This is finer than the MPR121 hardware
 * decision and is what fights spurious triggers.
 *
 * Filtered data is read one sensor per frame (round-robin) to keep the I2C cost
 * per frame low; the decision state persists per electrode so the output bitmap
 * stays current every frame.
 */

#include "touch.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdbool.h>

#include "bsp/board.h"
#include "hardware/gpio.h"
#include "hardware/i2c.h"

#include "board_defs.h"

#include "config.h"
#include "mpr121.h"

static unsigned touch_counts[36];

static uint8_t touch_map[] = TOUCH_MAP;

/* Per physical electrode (0..35) processing state. */
static struct {
    uint16_t filtered[36];
    uint16_t baseline[36];
    int16_t delta[36];
    uint8_t on_count[36];
    uint8_t off_count[36];
    bool active[36];
} ts;

static uint16_t avg_hist[36][SENSE_AVG_MAX];
static uint8_t avg_idx[3];

static uint64_t touch_reading;
static uint64_t delay_queue[SENSE_LATENCY_MAX + 1];
static uint8_t delay_pos;

static bool sensor_ok[3];

void touch_sensor_init()
{
    for (int m = 0; m < 3; m++) {
        mpr121_init(MPR121_BASE_ADDR + m);
    }
    touch_update_config();
    touch_rebase();
}

void touch_init()
{
    i2c_init(I2C_PORT, I2C_FREQ);
    gpio_set_function(I2C_SDA, GPIO_FUNC_I2C);
    gpio_set_function(I2C_SCL, GPIO_FUNC_I2C);
    gpio_pull_up(I2C_SDA);
    gpio_pull_up(I2C_SCL);

    memcpy(touch_map, mai_cfg->alt.touch, sizeof(touch_map));
    touch_sensor_init();
}

const char *touch_key_name(unsigned key)
{
    static char name[3] = { 0 };
    if (key < 18) {
        name[0] = "ABC"[key / 8];
        name[1] = '1' + key % 8;
    } else if (key < 34) {
        name[0] = "DE"[(key - 18) / 8];
        name[1] = '1' + (key - 18) % 8;
    } else {
        return "XX";
    }
    return name;
}

int touch_key_by_name(const char *name)
{
    if (strlen(name) != 2) {
        return -1;
    }
    if (strcasecmp(name, "XX") == 0) {
        return 255;
    }

    int zone = toupper(name[0]) - 'A';
    int id = name[1] - '1';
    if ((zone < 0) || (zone > 4) || (id < 0) || (id > 7)) {
        return -1;
    }
    if ((zone == 2) && (id > 1)) {
        return -1; // C1 and C2 only
    }
    const int offsets[] = { 0, 8, 16, 18, 26 };
    return offsets[zone] + id;
}

int touch_key_channel(unsigned key)
{
    for (int i = 0; i < 36; i++) {
        if (touch_map[i] == key) {
            return i;
        }
    }
    return -1;
}

unsigned touch_key_from_channel(unsigned channel)
{
    if (channel < 36) {
        return touch_map[channel];
    }
    return 0xff;
}

void touch_set_map(unsigned sensor, unsigned key)
{
    if (sensor < 36) {
        touch_map[sensor] = key;
        memcpy(mai_cfg->alt.touch, touch_map, sizeof(mai_cfg->alt.touch));
        config_changed();
    }
}

void touch_rebase()
{
    for (int m = 0; m < 3; m++) {
        uint16_t f[12] = {0};
        uint8_t b[12] = {0};
        sensor_ok[m] = mpr121_raw(MPR121_BASE_ADDR + m, f, 12);
        mpr121_baseline(MPR121_BASE_ADDR + m, b, 12);
        for (int i = 0; i < 12; i++) {
            int ch = m * 12 + i;
            ts.filtered[ch] = f[i];
            ts.baseline[ch] = (uint16_t)b[i] << 2;
            ts.delta[ch] = 0;
            ts.on_count[ch] = 0;
            ts.off_count[ch] = 0;
            ts.active[ch] = false;
            for (int k = 0; k < SENSE_AVG_MAX; k++) {
                avg_hist[ch][k] = f[i];
            }
        }
        avg_idx[m] = 0;
    }
    for (int k = 0; k <= SENSE_LATENCY_MAX; k++) {
        delay_queue[k] = 0;
    }
    delay_pos = 0;
    touch_reading = 0;
}

static void update_baseline(int m)
{
    if (mai_cfg->sense.baseline_mode == 0) {
        // Hardware baseline: read the MPR121 tracked baseline at a low cadence
        // (it drifts slowly, no need to poll it every frame).
        static uint32_t last_ms[3] = {0, 0, 0};
        uint32_t now = board_millis();
        if (now - last_ms[m] >= 50) {
            last_ms[m] = now;
            uint8_t b[12] = {0};
            if (mpr121_baseline(MPR121_BASE_ADDR + m, b, 12)) {
                for (int i = 0; i < 12; i++) {
                    ts.baseline[m * 12 + i] = (uint16_t)b[i] << 2;
                }
            }
        }
    } else {
        // Software drift: nudge the baseline toward the filtered value, but
        // freeze it while a channel is active (an held touch must not be
        // absorbed and dropped).
        static uint16_t drift[3] = {0, 0, 0};
        if (++drift[m] < mai_cfg->sense.baseline_rate) {
            return;
        }
        drift[m] = 0;
        for (int i = 0; i < 12; i++) {
            int ch = m * 12 + i;
            if (ts.active[ch]) {
                continue;
            }
            if (ts.baseline[ch] < ts.filtered[ch]) {
                ts.baseline[ch]++;
            } else if (ts.baseline[ch] > ts.filtered[ch]) {
                ts.baseline[ch]--;
            }
        }
    }
}

static void decide_channel(int ch)
{
    unsigned zone = touch_map[ch];
    if (zone >= 34) {
        return;
    }

    int32_t d = (int32_t)ts.baseline[ch] - (int32_t)ts.filtered[ch];
    if (d < 0) {
        d = 0;
    }
    ts.delta[ch] = d;

    int32_t on = mai_cfg->sense.threshold[zone];
    int32_t off = on - (on * mai_cfg->sense.hysteresis) / 100;
    int32_t thr = ts.active[ch] ? off : on;

    if (d >= thr) {
        if (ts.on_count[ch] < 250) {
            ts.on_count[ch]++;
        }
        ts.off_count[ch] = 0;
        if (ts.on_count[ch] >= mai_cfg->sense.debounce_on) {
            ts.active[ch] = true;
        }
    } else {
        if (ts.off_count[ch] < 250) {
            ts.off_count[ch]++;
        }
        ts.on_count[ch] = 0;
        if (ts.off_count[ch] >= mai_cfg->sense.debounce_off) {
            ts.active[ch] = false;
        }
    }
}

static void touch_stat()
{
    static uint64_t last_reading;

    uint64_t just_touched = touch_reading & ~last_reading;
    last_reading = touch_reading;

    for (int i = 0; i < 34; i++) {
        if (just_touched & (1ULL << i)) {
            touch_counts[i]++;
        }
    }
}

void touch_update()
{
    static int rr = 0;

    // Read one sensor's filtered data this frame (round-robin).
    uint16_t f[12] = {0};
    sensor_ok[rr] = mpr121_raw(MPR121_BASE_ADDR + rr, f, 12);

    update_baseline(rr);

    uint8_t avg = mai_cfg->sense.avg;
    for (int i = 0; i < 12; i++) {
        int ch = rr * 12 + i;
        if (avg > 1) {
            avg_hist[ch][avg_idx[rr]] = f[i];
            uint32_t sum = 0;
            for (int k = 0; k < avg; k++) {
                sum += avg_hist[ch][k];
            }
            ts.filtered[ch] = sum / avg;
        } else {
            ts.filtered[ch] = f[i];
        }
        decide_channel(ch);
    }
    if (avg > 1) {
        if (++avg_idx[rr] >= avg) {
            avg_idx[rr] = 0;
        }
    }

    rr = (rr + 1) % 3;

    // Rebuild the zone bitmap from the persistent per-electrode decision.
    uint64_t zones = 0;
    for (int ch = 0; ch < 36; ch++) {
        unsigned zone = touch_map[ch];
        if ((zone < 34) && ts.active[ch]) {
            zones |= 1ULL << zone;
        }
    }

    // Optional output latency (delay line). latency == 0 -> pass-through.
    uint8_t depth = mai_cfg->sense.latency;
    delay_queue[delay_pos] = zones;
    delay_pos = (delay_pos + 1) % (depth + 1);
    touch_reading = delay_queue[delay_pos];

    touch_stat();
}

bool touch_sensor_ok(unsigned i)
{
    if (i < 3) {
        return sensor_ok[i];
    }
    return false;
}

const uint16_t *touch_filtered()
{
    return ts.filtered;
}

const uint16_t *touch_baselines()
{
    return ts.baseline;
}

const int16_t *touch_deltas()
{
    return ts.delta;
}

bool touch_touched(unsigned key)
{
    if (key >= 34) {
        return 0;
    }
    return touch_reading & (1ULL << key);
}

uint64_t touch_touchmap()
{
    return touch_reading;
}

unsigned touch_count(unsigned key)
{
    if (key >= 34) {
        return 0;
    }
    return touch_counts[key];
}

void touch_reset_stat()
{
    memset(touch_counts, 0, sizeof(touch_counts));
}

void touch_update_config()
{
    // Only the MPR121 analog front-end is configured here; the touch decision
    // itself is done in software (see touch_update).
    for (int m = 0; m < 3; m++) {
        mpr121_gain(MPR121_BASE_ADDR + m,
                    mai_cfg->sense.gain_cdc, mai_cfg->sense.gain_cdt);
        mpr121_filter(MPR121_BASE_ADDR + m,
                      mai_cfg->sense.filter >> 6,
                      (mai_cfg->sense.filter >> 4) & 0x03,
                      mai_cfg->sense.filter & 0x07);
    }
}

/*
 * Controller Config and Runtime Data
 * WHowe <github.com/whowechina>
 * 
 * Config is a global data structure that stores all the configuration
 * Runtime is something to share between files.
 */

#include <string.h>

#include "config.h"
#include "save.h"
#include "touch.h"

mai_cfg_t *mai_cfg;

static mai_cfg_t default_cfg = {
    .color = {
        .level = 127,
    },
    .sense = {
        .threshold = { [0 ... 33] = 35 }, // strict by default: fights over-sensitivity
        .hysteresis = 25,
        .filter = 0x10,
        .avg = 2,
        .latency = 0,
        .debounce_on = 1,   // near-instant press (low latency)
        .debounce_off = 3,  // stable hold; release latency matters less
        .baseline_mode = 0, // MPR121 hardware baseline (freezes while touched)
        .baseline_rate = 400,
        .gain_cdc = 16,
        .gain_cdt = 1,
     },
    .hid = {
        .io4 = 1,
        .nkro = 0,
    },
    .rgb = {
        .per_button = 1,
        .per_cab = 1,
    },
    .alt = {
        .buttons = { -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1 },
        .touch = TOUCH_MAP,
        .rgb_button = { -1, -1, -1, -1, -1, -1, -1, -1 },
    },
    .aime = {
        .mode = 0,
        .virtual_aic = 0,
    },
    .tweak = {
        .main_button_active_high = 0,
        .aux_button_active_high = 0,
    },
};

mai_runtime_t mai_runtime;

static inline bool in_range(int val, int min, int max)
{
    return (val >= min) && (val <= max);
}

static bool touch_map_valid()
{
    uint64_t mask = 0;
    for (int i = 0; i < sizeof(mai_cfg->alt.touch); i++) {
        if (mai_cfg->alt.touch[i] < 34) {
            mask |= 1ULL << mai_cfg->alt.touch[i];
        }
    }
    int keys = 0;
    for (int i = 0; i < 34; i++) {
        if (mask & (1ULL << i)) {
            keys++;
        }
    }
    return keys > 10; // bad data results in low touch key coverage
}

static bool sense_valid()
{
    if (!in_range(mai_cfg->sense.hysteresis, 0, SENSE_HYST_MAX) ||
        !in_range(mai_cfg->sense.avg, SENSE_AVG_MIN, SENSE_AVG_MAX) ||
        !in_range(mai_cfg->sense.latency, 0, SENSE_LATENCY_MAX) ||
        !in_range(mai_cfg->sense.debounce_on, 0, SENSE_DEBOUNCE_MAX) ||
        !in_range(mai_cfg->sense.debounce_off, 0, SENSE_DEBOUNCE_MAX) ||
        !in_range(mai_cfg->sense.baseline_mode, 0, 1) ||
        !in_range(mai_cfg->sense.baseline_rate, SENSE_RATE_MIN, SENSE_RATE_MAX) ||
        !in_range(mai_cfg->sense.gain_cdc, 0, SENSE_GAIN_CDC_MAX) ||
        !in_range(mai_cfg->sense.gain_cdt, 0, SENSE_GAIN_CDT_MAX)) {
        return false;
    }
    for (int i = 0; i < 34; i++) {
        if (!in_range(mai_cfg->sense.threshold[i],
                      SENSE_THRESHOLD_MIN, SENSE_THRESHOLD_MAX)) {
            return false;
        }
    }
    return true;
}

static void config_loaded()
{
    if (!sense_valid()) {
        mai_cfg->sense = default_cfg.sense;
        config_changed();
    }

    if (!in_range(mai_cfg->rgb.per_button, 1, 16) ||
        !in_range(mai_cfg->rgb.per_cab, 0, 128)) {
        mai_cfg->rgb = default_cfg.rgb;
        config_changed();
    }

    if (!touch_map_valid()) {
        memcpy(mai_cfg->alt.touch, default_cfg.alt.touch,
               sizeof(mai_cfg->alt.touch));
        config_changed();
    }
}

void config_changed()
{
    save_request(false);
}

void config_factory_reset()
{
    *mai_cfg = default_cfg;
    save_request(true);
}

void config_init()
{
    mai_cfg = (mai_cfg_t *)save_alloc(sizeof(*mai_cfg), &default_cfg, config_loaded);
}

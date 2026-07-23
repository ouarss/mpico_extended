#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <ctype.h>

#include "pico/stdio.h"
#include "pico/stdlib.h"

#include "tusb.h"
#include "bsp/board.h"

#include "mpr121.h"
#include "touch.h"
#include "button.h"
#include "rgb.h"
#include "config.h"
#include "save.h"
#include "cli.h"

#include "aime.h"
#include "nfc.h"

static void disp_rgb()
{
    printf("[RGB]\n");
    printf("  LED Number for Button: %d\n"
           "  LED Number for Cabinet Light: %d\n"
           "  LED Number for Banner: %d\n",
            mai_cfg->rgb.per_button, mai_cfg->rgb.per_cab, mai_cfg->rgb.per_banner);
    printf("  Level: %d\n", mai_cfg->color.level);
    printf("  Button LED Order:\n   ");
    for (int i = 0; i < 8; i++) {
        printf(" B%d:%d", i + 1, rgb_button_led(i));
    }
    printf("\n");
}

static void print_threshold_zone(const char *title, int offset, int num)
{
    printf("   %s |", title);
    for (int i = 0; i < num; i++) {
        printf("%4d|", mai_cfg->sense.threshold[offset + i]);
    }
    printf("\n");
}

static void disp_sense()
{
    printf("[Sense]\n");
    printf("  Thresholds (higher = less sensitive):\n");
    printf("     |__1_|__2_|__3_|__4_|__5_|__6_|__7_|__8_|\n");
    print_threshold_zone("A", 0, 8);
    print_threshold_zone("B", 8, 8);
    print_threshold_zone("C", 16, 2);
    print_threshold_zone("D", 18, 8);
    print_threshold_zone("E", 26, 8);
    printf("  Hysteresis: %u%%   Avg: %u   Latency: %u\n",
           mai_cfg->sense.hysteresis, mai_cfg->sense.avg, mai_cfg->sense.latency);
    printf("  Debounce (on, off): %u, %u\n",
           mai_cfg->sense.debounce_on, mai_cfg->sense.debounce_off);
    printf("  Baseline: %s (rate %u)\n",
           mai_cfg->sense.baseline_mode ? "soft" : "hw",
           mai_cfg->sense.baseline_rate);
    printf("  Gain (cdc, cdt): %u, %u   Filter (ffi, sfi, esi): %u, %u, %u\n",
           mai_cfg->sense.gain_cdc, mai_cfg->sense.gain_cdt,
           mai_cfg->sense.filter >> 6, (mai_cfg->sense.filter >> 4) & 0x03,
           mai_cfg->sense.filter & 0x07);
}

static bool feeding = false;

// Machine-readable sensitivity config for the monitor (one JSON line, tag 'C').
static void feed_publish_config()
{
    printf("\nC {\"thr\":[");
    for (int i = 0; i < 34; i++) {
        printf(i ? ",%u" : "%u", mai_cfg->sense.threshold[i]);
    }
    printf("],\"map\":[");
    for (int i = 0; i < 36; i++) {
        printf(i ? ",%u" : "%u", mai_cfg->alt.touch[i]);
    }
    printf("],\"rgbMap\":[");
    for (int i = 0; i < 8; i++) {
        printf(i ? ",%u" : "%u", mai_cfg->alt.rgb_button[i]);
    }
    printf("],\"hyst\":%u,\"filter\":%u,\"avg\":%u,\"latency\":%u,"
           "\"baselineMode\":%u,\"rate\":%u,\"gainCdc\":%u,\"gainCdt\":%u,"
           "\"debounceOn\":%u,\"debounceOff\":%u,"
           "\"level\":%u,\"rgbButton\":%u,\"rgbCab\":%u,\"rgbBanner\":%u,"
           "\"hidIo4\":%u,\"hidNkro\":%u,\"aimeMode\":%u,\"aimeVirtual\":%u,"
           "\"tweakMain\":%u,\"tweakAux\":%u,"
           "\"saved\":%s}\n",
           mai_cfg->sense.hysteresis, mai_cfg->sense.filter, mai_cfg->sense.avg,
           mai_cfg->sense.latency, mai_cfg->sense.baseline_mode,
           mai_cfg->sense.baseline_rate, mai_cfg->sense.gain_cdc,
           mai_cfg->sense.gain_cdt, mai_cfg->sense.debounce_on,
           mai_cfg->sense.debounce_off,
           mai_cfg->color.level, mai_cfg->rgb.per_button, mai_cfg->rgb.per_cab,
           mai_cfg->rgb.per_banner, mai_cfg->hid.io4, mai_cfg->hid.nkro,
           mai_cfg->aime.mode, mai_cfg->aime.virtual_aic,
           mai_cfg->tweak.main_button_active_high,
           mai_cfg->tweak.aux_button_active_high,
           save_pending() ? "false" : "true");
}

// Common tail after any sensitivity change: persist, notify the monitor, echo.
static void sense_changed()
{
    config_changed();
    if (feeding) {
        feed_publish_config();
    }
    disp_sense();
}

static void disp_hid()
{
    printf("[HID]\n");
    const char *nkro[] = {"off", "key1", "key2"};
    printf("  IO4: %s, NKRO: %s\n", mai_cfg->hid.io4 ? "on" : "off",
           mai_cfg->hid.nkro <= 2 ? nkro[mai_cfg->hid.nkro] : "key1");
    if (mai_runtime.key_stuck) {
        printf("  !!! Button stuck, force IO4 only !!!\n");
    }
}

static void disp_aime()
{
    printf("[AIME]\n");
    printf("  NFC Module: %s\n", nfc_module_name());
    printf("  Virtual AIC: %s\n", mai_cfg->aime.virtual_aic ? "ON" : "OFF");
    printf("  Protocol Mode: %d\n", mai_cfg->aime.mode);
}

static void disp_gpio()
{
    printf("[GPIO]\n ");
    for (int i = 0; i < 8; i++) {
        printf(" B%d:GP%d", i + 1, button_real_gpio(i));
    }
    printf("\n  Test:GP%d Svc:GP%d Nav:GP%d Coin:GP%d\n",
        button_real_gpio(8), button_real_gpio(9),
        button_real_gpio(10), button_real_gpio(11));
}

static void disp_touch()
{
    printf("[Touch]\n");
    printf("     ADDR|_0|_1|_2|_3|_4|_5|_6|_7|_8|_9|10|11|\n");

    for (int m = 0; m < 3; m++) {
        printf("  %d: 0x%02x|", m, MPR121_BASE_ADDR + m);
        for (int chn = 0; chn < 12; chn++) {
            int key = touch_key_from_channel(m * 12 + chn);
            printf("%2s|", touch_key_name(key));
        }
        printf("\n");
    }
}

static void disp_tweak()
{
    printf("[Tweak]\n");
    printf("  Main Buttons Active-High: %s\n",
           mai_cfg->tweak.main_button_active_high ? "ON" : "OFF");
    printf("  Aux Buttons Active-High: %s\n",
           mai_cfg->tweak.aux_button_active_high ? "ON" : "OFF");
}

#define ARRAYSIZE(x) (sizeof(x) / sizeof(x[0]))

void handle_display(int argc, char *argv[])
{
    const char *usage = "Usage: display [rgb|sense|hid|gpio|touch|aime|tweak]\n";
    if (argc > 1) {
        printf(usage);
        return;
    }

    const char *choices[] = {"rgb", "sense", "hid", "gpio", "touch", "aime", "tweak"};
    static void (*disp_funcs[])() = {
        disp_rgb,
        disp_sense,
        disp_hid,
        disp_gpio,
        disp_touch,
        disp_aime,
        disp_tweak,
    };
  
    static_assert(ARRAYSIZE(choices) == ARRAYSIZE(disp_funcs),
        "Choices and disp_funcs arrays must have the same number of elements");

    if (argc == 0) {
        for (int i = 0; i < ARRAYSIZE(disp_funcs); i++) {
            disp_funcs[i]();
        }
        return;
    }

    int choice = cli_match_prefix(choices, ARRAYSIZE(choices), argv[0]);
    if (choice < 0) {
        printf(usage);
        return;
    }

    if (choice > ARRAYSIZE(disp_funcs)) {
        return;
    }

    disp_funcs[choice]();
}

static void handle_rgb(int argc, char *argv[])
{
    const char *usage = "Usage: rgb <per_button> <per_cab> <per_banner>\n"
                        "  per_button: [0..15] LED number per button\n"
                        "  per_cab: [0..15] LED number for each cabinet light\n"
                        "  per_banner: [0..15] LED number for the banner\n";
    if (argc != 3) {
        printf(usage);
        return;
    }

    int per_button = cli_extract_non_neg_int(argv[0], 0);
    int per_cab = cli_extract_non_neg_int(argv[1], 0);
    int per_banner = cli_extract_non_neg_int(argv[2], 0);

    if ((per_button < 0) || (per_cab < 0) || (per_banner < 0) ||
        (per_button > 15) || (per_cab > 15) || (per_banner > 15)) {
        printf(usage);
        return;
    }

    mai_cfg->rgb.per_button = per_button;
    mai_cfg->rgb.per_cab = per_cab;
    mai_cfg->rgb.per_banner = per_banner;

    config_changed();
    if (feeding) feed_publish_config();
    disp_rgb();
}

static void handle_level(int argc, char *argv[])
{
    const char *usage = "Usage: level <0..255>\n";
    if (argc != 1) {
        printf(usage);
        return;
    }

    int level = cli_extract_non_neg_int(argv[0], 0);
    if ((level < 0) || (level > 255)) {
        printf(usage);
        return;
    }

    mai_cfg->color.level = level;
    config_changed();
    if (feeding) feed_publish_config();
    disp_rgb();
}

static void handle_stat(int argc, char *argv[])
{
    if (argc == 0) {
        for (int col = 0; col < 4; col++) {
            printf(" %2dA |", col * 4 + 1);
            for (int i = 0; i < 4; i++) {
                printf("%6u|", touch_count(col * 8 + i * 2));
            }
            printf("\n   B |");
            for (int i = 0; i < 4; i++) {
                printf("%6u|", touch_count(col * 8 + i * 2 + 1));
            }
            printf("\n");
        }
    } else if ((argc == 1) &&
               (strncasecmp(argv[0], "reset", strlen(argv[0])) == 0)) {
        touch_reset_stat();
    } else {
        printf("Usage: stat [reset]\n");
    }
}

static void handle_hid(int argc, char *argv[])
{
    const char *usage = "Usage: hid <io4|key1|key2|off>\n";
    if (argc != 1) {
        printf(usage);
        return;
    }

    const char *choices[] = {"io4", "key1", "key2", "off"};
    int match = cli_match_prefix(choices, count_of(choices), argv[0]);
    if (match < 0) {
        printf(usage);
        return;
    }

    switch (match) {
        case 1:
            mai_cfg->hid.io4 = 0;
            mai_cfg->hid.nkro = 1;
            break;
        case 2:
            mai_cfg->hid.io4 = 0;
            mai_cfg->hid.nkro = 2;
            break;
        case 3:
            mai_cfg->hid.io4 = 0;
            mai_cfg->hid.nkro = 0;
            break;
        case 0:
        default:
            mai_cfg->hid.io4 = 1;
            mai_cfg->hid.nkro = 0;
            break;
    }
    config_changed();
    if (feeding) feed_publish_config();
    disp_hid();
}

static void handle_filter(int argc, char *argv[])
{
    const char *usage = "Usage: filter <first> <second> [interval]\n"
                        "Adjusts MPR121 noise filtering parameters (see datasheets).\n"
                        "    first:    First Filter Iterations  (FFI) [0..3]\n"
                        "    second:   Second Filter Iterations (SFI) [0..3]\n"
                        "    interval: Electrode Sample Interval (ESI) [0..7]\n";
    if ((argc < 2) || (argc > 3)) {
        printf(usage);
        return;
    }

    int ffi = cli_extract_non_neg_int(argv[0], 0);
    int sfi = cli_extract_non_neg_int(argv[1], 0);
    int intv = mai_cfg->sense.filter & 0x07;
    if (argc == 3) {
        intv = cli_extract_non_neg_int(argv[2], 0);
    }

    if ((ffi < 0) || (ffi > 3) || (sfi < 0) || (sfi > 3) ||
        (intv < 0) || (intv > 7)) {
        printf(usage);
        return;
    }

    mai_cfg->sense.filter = (ffi << 6) | (sfi << 4) | intv;

    touch_update_config();
    sense_changed();
}

static int extract_zone(const char *param)
{
    if (strlen(param) != 2) {
        return -1;
    }

    int zone = toupper((unsigned char)param[0]) - 'A';
    int id = param[1] - '1';

    if (zone < 0 || zone > 4 || id < 0 || id > 7) {
        return -1;
    }
    if ((zone == 2) && (id > 1)) {
        return -1; // C1 and C2 only
    }

    const int offsets[] = { 0, 8, 16, 18, 26 };

    return offsets[zone] + id;
}

static void handle_thr(int argc, char *argv[])
{
    const char *usage = "Usage: thr <zone|all> <1..1000>\n"
                        "  Absolute per-zone threshold. Higher = less sensitive.\n"
                        "Example:\n"
                        "  >thr A3 40\n"
                        "  >thr all 35\n";
    if (argc != 2) {
        printf(usage);
        return;
    }

    int val = cli_extract_non_neg_int(argv[1], 0);
    if ((val < SENSE_THRESHOLD_MIN) || (val > SENSE_THRESHOLD_MAX)) {
        printf(usage);
        return;
    }

    if (strcasecmp(argv[0], "all") == 0) {
        for (int i = 0; i < 34; i++) {
            mai_cfg->sense.threshold[i] = val;
        }
    } else {
        int zone = extract_zone(argv[0]);
        if (zone < 0) {
            printf(usage);
            return;
        }
        mai_cfg->sense.threshold[zone] = val;
    }

    sense_changed();
}

static void handle_hyst(int argc, char *argv[])
{
    const char *usage = "Usage: hyst <0..90>\n"
                        "  Release margin, percent of the threshold.\n";
    if (argc != 1) {
        printf(usage);
        return;
    }
    int v = cli_extract_non_neg_int(argv[0], 0);
    if ((v < 0) || (v > SENSE_HYST_MAX)) {
        printf(usage);
        return;
    }
    mai_cfg->sense.hysteresis = v;
    sense_changed();
}

static void handle_latency(int argc, char *argv[])
{
    const char *usage = "Usage: latency <0..9>\n"
                        "  Output delay in frames.\n";
    if (argc != 1) {
        printf(usage);
        return;
    }
    int v = cli_extract_non_neg_int(argv[0], 0);
    if ((v < 0) || (v > SENSE_LATENCY_MAX)) {
        printf(usage);
        return;
    }
    mai_cfg->sense.latency = v;
    sense_changed();
}

static void handle_avg(int argc, char *argv[])
{
    const char *usage = "Usage: avg <1..16>\n"
                        "  Software moving-average window (1 = off, lowest latency).\n";
    if (argc != 1) {
        printf(usage);
        return;
    }
    int v = cli_extract_non_neg_int(argv[0], 0);
    if ((v < SENSE_AVG_MIN) || (v > SENSE_AVG_MAX)) {
        printf(usage);
        return;
    }
    mai_cfg->sense.avg = v;
    sense_changed();
}

static void handle_gain(int argc, char *argv[])
{
    const char *usage = "Usage: gain <cdc 0..63> <cdt 0..7>\n"
                        "  MPR121 charge current (cdc) and charge time (cdt).\n";
    if (argc != 2) {
        printf(usage);
        return;
    }
    int cdc = cli_extract_non_neg_int(argv[0], 0);
    int cdt = cli_extract_non_neg_int(argv[1], 0);
    if ((cdc < 0) || (cdc > SENSE_GAIN_CDC_MAX) ||
        (cdt < 0) || (cdt > SENSE_GAIN_CDT_MAX)) {
        printf(usage);
        return;
    }
    mai_cfg->sense.gain_cdc = cdc;
    mai_cfg->sense.gain_cdt = cdt;
    touch_update_config();
    sense_changed();
}

static void handle_baseline(int argc, char *argv[])
{
    const char *usage = "Usage: baseline <hw|soft> [rate]\n"
                        "  hw   = MPR121 hardware tracking (default)\n"
                        "  soft = software drift; rate = frames per step\n";
    if ((argc < 1) || (argc > 2)) {
        printf(usage);
        return;
    }
    const char *choices[] = {"hw", "soft"};
    int match = cli_match_prefix(choices, 2, argv[0]);
    if (match < 0) {
        printf(usage);
        return;
    }
    if (argc == 2) {
        int rate = cli_extract_non_neg_int(argv[1], 0);
        if ((rate < SENSE_RATE_MIN) || (rate > SENSE_RATE_MAX)) {
            printf(usage);
            return;
        }
        mai_cfg->sense.baseline_rate = rate;
    }
    mai_cfg->sense.baseline_mode = match;
    touch_rebase();
    sense_changed();
}

static void handle_rebase()
{
    touch_rebase();
    printf("Touch baseline re-based.\n");
}

static void handle_preset(int argc, char *argv[])
{
    const char *usage = "Usage: preset <default|flat> [value]\n"
                        "  default   = reset all thresholds to 35\n"
                        "  flat <v>  = set all thresholds to v\n";
    if (argc < 1) {
        printf(usage);
        return;
    }
    if (strcasecmp(argv[0], "default") == 0) {
        for (int i = 0; i < 34; i++) {
            mai_cfg->sense.threshold[i] = 35;
        }
    } else if ((strcasecmp(argv[0], "flat") == 0) && (argc == 2)) {
        int v = cli_extract_non_neg_int(argv[1], 0);
        if ((v < SENSE_THRESHOLD_MIN) || (v > SENSE_THRESHOLD_MAX)) {
            printf(usage);
            return;
        }
        for (int i = 0; i < 34; i++) {
            mai_cfg->sense.threshold[i] = v;
        }
    } else {
        printf(usage);
        return;
    }
    sense_changed();
}

static void handle_debounce(int argc, char *argv[])
{
    const char *usage = "Usage: debounce <on> [off]\n"
                        "  on, off: consecutive samples before ON/OFF, 0..15\n";
    if ((argc < 1) || (argc > 2)) {
        printf(usage);
        return;
    }

    int on = cli_extract_non_neg_int(argv[0], 0);
    int off = mai_cfg->sense.debounce_off;
    if (argc == 2) {
        off = cli_extract_non_neg_int(argv[1], 0);
    }

    if ((on < 0) || (off < 0) ||
        (on > SENSE_DEBOUNCE_MAX) || (off > SENSE_DEBOUNCE_MAX)) {
        printf(usage);
        return;
    }

    mai_cfg->sense.debounce_on = on;
    mai_cfg->sense.debounce_off = off;

    sense_changed();
}

static void handle_raw()
{
    const uint16_t *filt = touch_filtered();
    const uint16_t *base = touch_baselines();
    const int16_t *dlt = touch_deltas();

    printf("Touch readings (software decision):\n");
    printf("   Sensor: 0:%s 1:%s 2:%s\n",
            touch_sensor_ok(0) ? "OK" : "ERR",
            touch_sensor_ok(1) ? "OK" : "ERR",
            touch_sensor_ok(2) ? "OK" : "ERR");
    printf("   zone | filt | base | delta |  thr\n");
    for (int zone = 0; zone < 34; zone++) {
        int ch = touch_key_channel(zone);
        if (ch < 0) {
            continue;
        }
        printf("     %2s |%5u |%5u |%6d |%5u\n",
               touch_key_name(zone), filt[ch], base[ch], dlt[ch],
               mai_cfg->sense.threshold[zone]);
    }
}

static void handle_whoami()
{
    const char *msg[] = {"\nThis is Command Line port.\n", "\nThis is Touch port.\n", "\nThis is LED port.\n"};
    for (int i = 0; i < 3; i++) {
        tud_cdc_n_write(i, msg[i], strlen(msg[i]));
        tud_cdc_n_write_flush(i);
    }
}

static void handle_save()
{
    save_request(true);
}

static void handle_gpio(int argc, char *argv[])
{
    const char *usage = "Usage: gpio main <gpio1> <gpio2> ... <gpio8>\n"
                        "       gpio <test|service|navigate|coin> <gpio>\n"
                        "       gpio reset\n"
                        "  gpio: 0..29\n";
    if (argc == 1) {
        if (strcasecmp(argv[0], "reset") != 0) {
            printf(usage);
            return;
        }
        for (int i = 0; i < sizeof(mai_cfg->alt.buttons); i++) {
            mai_cfg->alt.buttons[i] = 0xff;
        }
    } else if (argc == 9) {
        const char *choices[] = {"main"};
        if (cli_match_prefix(choices, 1, argv[0]) < 0) {
            printf(usage);
            return;
        }
        uint8_t gpio_main[8];
        for (int i = 0; i < 8; i++) {
            int gpio = cli_extract_non_neg_int(argv[i + 1], 0);
            if ((gpio < 0) || (gpio > 29)) {
                printf(usage);
                return;
            }
            gpio_main[i] = gpio;
        }
        for (int i = 0; i < 8; i++) {
            int gpio = gpio_main[i];
            bool is_default = (gpio == button_default_gpio(i));
            mai_cfg->alt.buttons[i] = is_default ? 0xff : gpio;
        }
    } else if (argc == 2) {
        const char *choices[] = {"test", "service", "navigate", "coin"};
        const uint8_t button_pos[] = {8, 9, 10, 11};
        int match = cli_match_prefix(choices, 4, argv[0]);
        uint8_t gpio = cli_extract_non_neg_int(argv[1], 0);
        if ((match < 0) || (gpio > 29)) {
            printf(usage);
            return;
        }
        int index = button_pos[match];
        bool is_default = (gpio == button_default_gpio(index));
        mai_cfg->alt.buttons[index] = is_default ? 0xff : gpio;
    } else {
        printf(usage);
        return;
    }
    config_changed();
    button_init(); // Re-init the buttons
    disp_gpio();
}

static void handle_rgbmap(int argc, char *argv[])
{
    const char *usage = "Usage: rgbmap <b1> <b2> <b3> <b4> <b5> <b6> <b7> <b8>\n"
                        "       rgbmap reset\n"
                        "  For each ring button B1..B8, give which LED position on the\n"
                        "  chain (0..7) lights it. The eight values are a permutation of\n"
                        "  0..7 (each LED used exactly once).\n"
                        "Example (full):\n"
                        "  >rgbmap 0 1 2 3 7 6 5 4\n";
    if (argc == 1) {
        if (strcasecmp(argv[0], "reset") != 0) {
            printf(usage);
            return;
        }
        for (int i = 0; i < sizeof(mai_cfg->alt.rgb_button); i++) {
            mai_cfg->alt.rgb_button[i] = 0xff;
        }
    } else if (argc == 8) {
        uint8_t pos[8];
        for (int i = 0; i < 8; i++) {
            int p = cli_extract_non_neg_int(argv[i], 0);
            if ((p < 0) || (p > 7)) {
                printf(usage);
                return;
            }
            pos[i] = p;
        }
        for (int i = 0; i < 8; i++) {
            bool is_default = (pos[i] == rgb_button_led_default(i));
            mai_cfg->alt.rgb_button[i] = is_default ? 0xff : pos[i];
        }
    } else {
        printf(usage);
        return;
    }
    config_changed();
    if (feeding) feed_publish_config();
    disp_rgb();
}

static void detect_touch()
{
    bool touched = false;
    for (int i = 0; i < 34; i++) {
        if (touch_touched(i)) {
            touched = true;
            printf("Touched: %s", touch_key_name(i));
            uint8_t pad = touch_key_channel(i);
            if (pad >= 0) {
                printf(" (Sensor %d, Electrode %d)\n", pad / 12, pad % 12 + 1);
            } else {
                printf(" (nil)\n");
            }
        }
    }
    if (!touched) {
        printf("No touch detected.\n");
    }
}

static bool set_touch_map(int argc, char *argv[])
{
    if (argc != 3) {
        return false;
    }
    if (strlen(argv[2]) != 2) {
        return false;
    }
    int sensor = cli_extract_non_neg_int(argv[0], 0);
    int channel = cli_extract_non_neg_int(argv[1], 0);
    int key = touch_key_by_name(argv[2]);

    if ((sensor < 0) || (sensor > 2) ||
        (channel < 0) || (channel > 11) ||
        (key < 0)) {
        return false;
    }
    touch_set_map(sensor * 12 + channel, key);
    return true;
}

static void handle_touch(int argc, char *argv[])
{
    const char *usage = "Usage: touch [<sensor> <channel> <key>]\n"
                        "  sensor: 0..2\n"
                        " channel: 0..11\n"
                        "     key: A1, C2, E5, etc. XX means Not Connected.)\n";
    if (argc == 0) {
        detect_touch();
    } else if (set_touch_map(argc, argv)) {
        disp_touch();
    } else {
        printf(usage);
    }
}


static bool handle_aime_mode(const char *mode)
{
    if (strcmp(mode, "0") == 0) {
        mai_cfg->aime.mode = 0;
    } else if (strcmp(mode, "1") == 0) {
        mai_cfg->aime.mode = 1;
    } else {
        return false;
    }
    aime_sub_mode(mai_cfg->aime.mode);
    config_changed();
    return true;
}

static bool handle_aime_virtual(const char *onoff)
{
    if (strcasecmp(onoff, "on") == 0) {
        mai_cfg->aime.virtual_aic = 1;
    } else if (strcasecmp(onoff, "off") == 0) {
        mai_cfg->aime.virtual_aic = 0;
    } else {
        return false;
    }
    aime_virtual_aic(mai_cfg->aime.virtual_aic);
    config_changed();
    return true;
}

static void handle_aime(int argc, char *argv[])
{
    const char *usage = "Usage:\n"
                        "    aime mode <0|1>\n"
                        "    aime virtual <on|off>\n";
    if (argc != 2) {
        printf("%s", usage);
        return;
    }

    const char *commands[] = { "mode", "virtual" };
    int match = cli_match_prefix(commands, 2, argv[0]);
    
    bool ok = false;
    if (match == 0) {
        ok = handle_aime_mode(argv[1]);
    } else if (match == 1) {
        ok = handle_aime_virtual(argv[1]);
    }

    if (ok) {
        if (feeding) feed_publish_config();
        disp_aime();
    } else {
        printf("%s", usage);
    }
}

static void handle_tweak(int argc, char *argv[])
{
    const char *usage = "Usage: tweak <option> <on|off>\n"
                        "Options:\n"
                        "    main_button_active_high\n"
                        "    aux_button_active_high\n";
    if (argc != 2) {
        printf(usage);
        return;
    }

    const char *options[] = {
        "main_button_active_high",
        "aux_button_active_high",
    };

    const char *switches[] = { "on", "off" };

    int option = cli_match_prefix(options, 2, argv[0]);
    int on_off = cli_match_prefix(switches, 2, argv[1]);
    if ((option < 0) || (on_off < 0)) {
        printf(usage);
        return;
    }

    bool active = on_off == 0 ? true : false;
    if (option == 0) {
        mai_cfg->tweak.main_button_active_high = active;
    } else if (option == 1) {
        mai_cfg->tweak.aux_button_active_high = active;
    }

    config_changed();
    if (feeding) feed_publish_config();
    disp_tweak();
}

// Machine data frame for the monitor (tag 'F'): 36 filtered, 36 delta, then the
// active-zone bitmap as two 32-bit hex halves. Built in one buffer to keep it on
// a single line and avoid flooding stdio with tiny writes.
static void feed_frame_line()
{
    const uint16_t *filt = touch_filtered();
    const int16_t *dlt = touch_deltas();
    uint64_t zones = touch_touchmap();

    char line[560];
    int n = 0;
    n += snprintf(line + n, sizeof(line) - n, "\nF");
    for (int i = 0; i < 36; i++) {
        n += snprintf(line + n, sizeof(line) - n, " %d", filt[i]);
    }
    for (int i = 0; i < 36; i++) {
        n += snprintf(line + n, sizeof(line) - n, " %d", dlt[i]);
    }
    snprintf(line + n, sizeof(line) - n, " %08lx%08lx\n",
             (uint32_t)(zones >> 32), (uint32_t)(zones & 0xffffffff));
    printf("%s", line);
}

void commands_feed_poll()
{
    if (!feeding) {
        return;
    }
    uint32_t now = board_millis();

    // Keep the monitor's config view in sync, whatever changed it (2 Hz).
    static uint32_t last_cfg = 0;
    if (now - last_cfg >= 500) {
        last_cfg = now;
        feed_publish_config();
    }

    static uint32_t last = 0;
    if (now - last < 40) { // ~25 Hz data frames
        return;
    }
    last = now;
    feed_frame_line();
}

static void handle_feed(int argc, char *argv[])
{
    const char *usage = "Usage: feed <on|off>\n"
                        "  Machine stream for the monitor (F data lines + C config).\n";
    if (argc != 1) {
        printf(usage);
        return;
    }
    const char *choices[] = {"off", "on"};
    int match = cli_match_prefix(choices, 2, argv[0]);
    if (match < 0) {
        printf(usage);
        return;
    }
    feeding = (match == 1);
    if (feeding) {
        feed_publish_config();
    }
}

void commands_init()
{
    cli_register("display", handle_display, "Display all config.");
    cli_register("rgb", handle_rgb, "Set RGB LED number for main button and aux buttons.");
    cli_register("level", handle_level, "Set LED brightness level.");
    cli_register("stat", handle_stat, "Display or reset statistics.");
    cli_register("hid", handle_hid, "Set HID mode.");
    cli_register("filter", handle_filter, "Set MPR121 pre-filter (FFI/SFI/ESI).");
    cli_register("gain", handle_gain, "Set MPR121 gain (cdc/cdt).");
    cli_register("thr", handle_thr, "Set absolute touch threshold per zone.");
    cli_register("hyst", handle_hyst, "Set release hysteresis (%).");
    cli_register("avg", handle_avg, "Set moving-average window.");
    cli_register("latency", handle_latency, "Set output latency (frames).");
    cli_register("debounce", handle_debounce, "Set debounce samples (on/off).");
    cli_register("baseline", handle_baseline, "Set baseline mode (hw/soft).");
    cli_register("rebase", handle_rebase, "Re-seed the idle baseline.");
    cli_register("preset", handle_preset, "Apply a threshold preset.");
    cli_register("feed", handle_feed, "Machine stream for the monitor.");
    cli_register("raw", handle_raw, "Show filtered/baseline/delta per zone.");
    cli_register("whoami", handle_whoami, "Identify each com port.");
    cli_register("save", handle_save, "Save config to flash.");
    cli_register("gpio", handle_gpio, "Set GPIO pins for buttons.");
    cli_register("rgbmap", handle_rgbmap, "Set button LED order.");
    cli_register("touch", handle_touch, "Custimze touch mapping.");
    cli_register("tweak", handle_tweak, "Miscellaneous tweak options.");
    cli_register("factory", config_factory_reset, "Reset everything to default.");
    cli_register("aime", handle_aime, "AIME settings.");
}

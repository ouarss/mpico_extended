/*
 * Controller Config
 * WHowe <github.com/whowechina>
 */

#ifndef CONFIG_H
#define CONFIG_H

#include <stdint.h>
#include <stdbool.h>

#include "board_defs.h"

/* Fine per-zone sensitivity model. The touch decision is done in software from
   the MPR121 filtered readings (delta = baseline - filtered), so thresholds are
   absolute per zone instead of coarse offsets around a fixed base. Higher
   threshold = less sensitive (needs a bigger delta to trigger). */
#define SENSE_THRESHOLD_MIN 1
#define SENSE_THRESHOLD_MAX 1000
#define SENSE_THRESHOLD_DEFAULT 35
#define SENSE_HYST_MAX 90
#define SENSE_AVG_MIN 1
#define SENSE_AVG_MAX 16
#define SENSE_DEBOUNCE_MAX 15
#define SENSE_RATE_MIN 1
#define SENSE_RATE_MAX 60000
#define SENSE_GAIN_CDC_MAX 63
#define SENSE_GAIN_CDT_MAX 7

/* One bound shared by the rgb command and the boot validation: a value the CLI
   accepts must never be silently reset at the next boot. */
#define RGB_PER_UNIT_MAX 15

typedef struct __attribute__((packed)) {
    struct {
        /* Compatibility padding from the upstream layout. Removing it would
           shift every field that follows and corrupt saved configs - leave it. */
        uint32_t not_used[2];
        uint8_t level;
    } color;
    struct {
        uint16_t threshold[34];  // absolute delta threshold per zone
        uint8_t hysteresis;      // release margin, percent of threshold
        uint8_t filter;          // MPR121 FFI/SFI/ESI packed
        uint8_t avg;             // software moving-average window, 1..16
        uint8_t reserved_latency; // was output delay (removed); kept for layout, forced 0
        uint8_t debounce_on;     // samples above threshold before ON
        uint8_t debounce_off;    // samples below release before OFF
        uint8_t baseline_mode;   // 0 = MPR121 hardware, 1 = software drift
        uint16_t baseline_rate;  // software drift: frames per step
        uint8_t gain_cdc;        // charge/discharge current, 0..63
        uint8_t gain_cdt;        // charge/discharge time, 0..7
    } sense;
    struct {
        uint8_t io4 : 4;
        uint8_t nkro : 4;
    } hid;
    struct {
        uint8_t per_button;
        uint8_t per_cab : 4;
        uint8_t per_banner : 4;
    } rgb;
    struct {
        uint8_t buttons[12];
        uint8_t touch[36];
        uint8_t rgb_button[8];
    } alt;
    struct {
        uint8_t mode : 4;
        uint8_t virtual_aic : 4;
    } aime;
    struct {
        uint8_t main_button_active_high : 1;
        uint8_t aux_button_active_high : 1;
        uint8_t unused_bits : 6;
        uint8_t reserved[3];
    } tweak;
    uint8_t reserved[8];
} mai_cfg_t;

typedef struct {
    bool key_stuck;
    struct {
        bool touch;
        bool led;
    } debug;
} mai_runtime_t;

extern mai_cfg_t *mai_cfg;
extern mai_runtime_t mai_runtime;

void config_init();
void config_changed(); // Notify the config has changed
void config_factory_reset(); // Reset the config to factory default

#endif

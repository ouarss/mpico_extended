/*
 * Mai Pico Touch Keys
 * WHowe <github.com/whowechina>
 */

#ifndef TOUCH_H
#define TOUCH_H

#include <stdint.h>
#include <stdbool.h>

enum touch_keys {
    A1 = 0, A2, A3, A4, A5, A6, A7, A8,
    B1, B2, B3, B4, B5, B6, B7, B8,
    C1, C2, D1, D2, D3, D4, D5, D6, D7, D8,
    E1, E2, E3, E4, E5, E6, E7, E8,
    XX = 255
};

const char *touch_key_name(unsigned key);
int touch_key_by_name(const char *name);
int touch_key_channel(unsigned key);
unsigned touch_key_from_channel(unsigned channel);

void touch_init();
void touch_sensor_init();
void touch_rebase(); // re-seed the idle baseline and clear the decision state
void touch_update();
bool touch_touched(unsigned key);
uint64_t touch_touchmap();
void touch_set_map(unsigned sensor, unsigned key);

bool touch_sensor_ok(unsigned i);

/* Live processing state, indexed by physical electrode (0..35). */
const uint16_t *touch_filtered();
const uint16_t *touch_baselines();
const int16_t *touch_deltas();

void touch_update_config();
unsigned touch_count(unsigned key);
void touch_reset_stat();

#endif

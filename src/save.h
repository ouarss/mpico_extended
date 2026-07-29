/*
 * Controller Flash Save and Load
 * WHowe <github.com/whowechina>
 *
 * Modified 2025-2026 for mpico_extended: save_pending() reports unsaved changes
 * to the monitor; an orphan locker typedef was removed.
 */

#ifndef SAVE_H
#define SAVE_H

#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

#include "pico/multicore.h"

uint32_t board_id_32();
uint64_t board_id_64();

/* It's safer to lock other I/O ops during saving, so we need a locker */
void save_init(uint32_t magic, mutex_t *lock);

void save_loop();

void *save_alloc(size_t size, void *def, void (*after_load)());
void save_request(bool immediately);

/* True when the live config differs from what is stored in flash. */
bool save_pending();

#endif

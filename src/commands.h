/*
 * Controller Command Line Commands
 * WHowe <github.com/whowechina>
 *
 * Modified 2025-2026 for mpico_extended: exposes commands_feed_poll(), the
 * machine data stream consumed by the web monitor.
 */

#ifndef COMMANDS_H
#define COMMANDS_H

void commands_init();
void commands_feed_poll(); // emit the monitor data stream when 'feed on'

#endif

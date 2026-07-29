/*
 * MPR121 Captive Touch Sensor
 * WHowe <github.com/whowechina>
 *
 * Modified 2025-2026 for mpico_extended: API for the filtered/baseline reads
 * and the front-end tuning; the unused hardware-decision calls were dropped.
 * 
 */

#ifndef MPR121_H
#define MPR121_H

#define MPR121_BASE_ADDR 0x5A

void mpr121_init(uint8_t addr);

bool mpr121_raw(uint8_t addr, uint16_t *raw, int num);

/* Hardware-tracked baseline, one byte per electrode (bits [10:2] of the value:
   shift left by 2 to compare against the 10-bit filtered readings). */
bool mpr121_baseline(uint8_t addr, uint8_t *baseline, int num);

void mpr121_filter(uint8_t addr, uint8_t ffi, uint8_t sfi, uint8_t esi);
void mpr121_gain(uint8_t addr, uint8_t cdc, uint8_t cdt);

/* Reseed the hardware baseline by toggling the ECR (stop then resume). With
   CL=10 ("load 5MSB") the MPR121 reloads its internal baseline from the current
   filtered value and re-runs autoconfig (the per-electrode charge-current
   search) -- the clean reset a stuck, slow-falling baseline needs. */
void mpr121_reseed(uint8_t addr);

#endif

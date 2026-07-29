/*
 * HID Report Functions
 * WHowe <github.com/whowechina>
 */

#ifndef HID_H_
#define HID_H_

void hid_update();
void hid_proc(const uint8_t *buffer, uint8_t len);

#endif

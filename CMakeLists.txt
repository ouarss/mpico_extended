# Modified 2025-2026 for mpico_extended: project renamed, so the binary and the
# CMake target no longer carry the upstream name.
cmake_minimum_required(VERSION 3.12)

# Pull in SDK (must set be before project)
include(pico_sdk_import.cmake)

project(mpico_extended C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

add_subdirectory(modules/aic_pico/firmware aic)
include_directories(modules/aic_pico/firmware/include)

add_subdirectory(src)

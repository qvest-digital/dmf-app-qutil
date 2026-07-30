cmake_minimum_required(VERSION 3.20)
project(mxl-multi-compositor CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GST REQUIRED IMPORTED_TARGET gstreamer-1.0 gstreamer-app-1.0)

add_executable(mxl-multi-compositor src/main.cpp)

# Audible previews of AUDIO flows, which mediamtx's mxlSource refuses. Same
# image and same libmxl/GStreamer link line as the compositor — it is the same
# job (read MXL, encode, RTSP-publish) on the sample API instead of the grain
# API, so it ships as a second entry point rather than a second image.
add_executable(mxl-audio-preview src/audio_preview.cpp)

# A real audio flow to preview. The audio flow this cluster already had is a
# byte-ramp integrity pattern, not PCM, so nothing could exercise the audio
# path end to end. No GStreamer here — it writes samples straight through
# libmxl — but it links the same way for simplicity.
add_executable(mxl-audio-testsrc src/audio_testsrc.cpp)

foreach(target mxl-multi-compositor mxl-audio-preview mxl-audio-testsrc)
  target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  # mxl headers vendored under vendor/ — runtime libmxl.so is provided by the
  # mxl-base image. No pkg-config entry available because mxl-base does not
  # ship a .pc file; we just link against libmxl directly.
  target_include_directories(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/vendor)
  target_link_libraries(${target} PRIVATE PkgConfig::GST mxl pthread)
endforeach()

install(TARGETS mxl-multi-compositor mxl-audio-preview mxl-audio-testsrc
        RUNTIME DESTINATION bin)

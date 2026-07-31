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

# A real DATA flow. Nothing in the demo wrote `video/smpte291`, so discrete data
# grains, their mirroring, and how the multiviewer presents a flow it cannot
# preview were all untested. Writes one RFC 8331 ancillary-timecode frame per
# grain; the framing itself lives in src/anc_frame.h so it can be tested without
# libmxl.
add_executable(mxl-anc-testsrc src/anc_testsrc.cpp)

foreach(target mxl-multi-compositor mxl-audio-preview mxl-audio-testsrc mxl-anc-testsrc)
  target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  # mxl headers vendored under vendor/ — runtime libmxl.so is provided by the
  # mxl-base image. No pkg-config entry available because mxl-base does not
  # ship a .pc file; we just link against libmxl directly.
  target_include_directories(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/vendor)
  target_link_libraries(${target} PRIVATE PkgConfig::GST mxl pthread)
endforeach()

install(TARGETS mxl-multi-compositor mxl-audio-preview mxl-audio-testsrc mxl-anc-testsrc
        RUNTIME DESTINATION bin)

# Round-trips the ANC framing through the parser libmxl's own mxl-data-probe
# uses, so a layout change on either side fails the image build rather than
# silently producing grains nothing can read. Links neither libmxl nor GStreamer
# — the framing is pure bit twiddling — and is not installed. C++20 because the
# transcribed parser uses std::span.
enable_testing()
add_executable(anc-frame-test test/anc_frame_test.cpp)
target_compile_features(anc-frame-test PRIVATE cxx_std_20)
target_compile_options(anc-frame-test PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME anc-frame COMMAND anc-frame-test)

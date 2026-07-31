// mxl-anc-testsrc
//
// Writes ancillary data into an MXL DATA flow, one RFC 8331 frame per grain,
// carrying a timecode that advances with the flow's own clock. It exists so the
// data-flow path has something real to carry: the demo had video and audio
// producers but nothing writing `video/smpte291`, so nothing exercised discrete
// data grains, their mirroring, or how the multiviewer presents a flow it cannot
// preview.
//
// GRAIN LAYOUT. MXL stores ancillary data as RFC 8331 *starting at the Length
// field* — libmxl's Architecture.md is explicit that the leading bytes of the RTP
// payload are redundant in MXL and are not stored. So a grain is a 6-byte header
// followed by ANC packet data:
//
//   word 0    Length              bytes of packet data after this header
//   word 1    ANC_Count << 8      F and reserved are zero
//   word 2    reserved
//   word 3    C(1) Line_Number(11) Horizontal_Offset high 4
//   word 4    Horizontal_Offset low 8, S(1), StreamNum(7)
//   word 5-6  DID(10) SDID(10) Data_Count(10), then 2 unused bits
//   word 7+   User_Data_Words, 10 bits each, then the checksum
//
// All words are big-endian. UDW start at the top of word 7 rather than in the two
// bits left over in word 6: that is what libmxl's own mxl-data-probe expects (its
// UdwUnpacker begins accumulating at a fresh word), and matching the reference
// reader matters more here than the stricter bit-packing reading of RFC 8331 — a
// test source nothing in the ecosystem can decode is not a test source. The
// round-trip test in compositor/test/anc_frame_test.cpp holds the framing to that
// parser, so if libmxl changes it, the build fails rather than the demo going
// quietly wrong.
//
// TIMECODE PAYLOAD. The packet is framed as SMPTE ST 12-2 Ancillary Time Code —
// DID/SDID 0x60/0x60, Data_Count 16 — which is what mxl-data-probe labels it, and
// the user data words carry the time as BCD, one field per word:
//
//   UDW[0] = hours    UDW[1] = minutes    UDW[2] = seconds    UDW[3] = frames
//   UDW[4..15] = 0
//
// That is deliberately NOT the ST 12M-2 bit layout, which packs a 64-bit timecode
// word with DBB1/DBB2 and binary groups across all 16 words. Nothing in this
// ecosystem decodes ATC user data — the probe prints the words raw — so a layout
// readable straight off that dump is worth more than an unverifiable imitation of
// the real thing. Do not point a conformant ATC decoder at this and expect it to
// read the time; if that day comes, replace anc::build_atc_udw and keep the
// framing.
//
// The 10-bit words do carry correct SMPTE 291 parity (b8 even over b0..b7, b9 its
// inverse) and a correct checksum, because those are cheap and a reader that does
// check them should not see this flow as corrupt.
//
// Flow registration is implicit: writing into the domain is enough. The node
// agent's fanotify watch sees the new flow directory, publishes the MxlFlow CR
// with this definition, and renews its origin Lease — so the flow appears in the
// multiviewer's Operator-flows list on its own, with Preview correctly refused
// (there is no route from a data flow to a browser).
//
// Env: MXL_DOMAIN (/run/mxl/domain), MXL_FLOW_ID, MXL_GRAIN_RATE_NUM (30000),
// MXL_GRAIN_RATE_DEN (1001), MXL_ANC_LINE (9), MXL_LABEL, MXL_DESCRIPTION.

#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>

#include <mxl/dataformat.h>
#include <mxl/flow.h>
#include <mxl/mxl.h>
#include <mxl/time.h>

#include "anc_frame.h"

namespace
{
    std::atomic<bool> g_exit{false};
    void on_signal(int) { g_exit.store(true, std::memory_order_relaxed); }

    std::string env_or(char const* key, char const* fallback)
    {
        char const* v = std::getenv(key);
        return v ? std::string{v} : std::string{fallback};
    }

    int env_int(char const* key, int fallback)
    {
        char const* v = std::getenv(key);
        if (v == nullptr) return fallback;
        try
        {
            return std::stoi(v);
        }
        catch (...)
        {
            return fallback;
        }
    }

    // NMOS-shaped flow definition, matching libmxl's own data_flow.json. Built
    // here rather than mounted from a ConfigMap: mxlCreateFlowWriter takes the
    // document as a string, so the deployment stays a single container with no
    // extra volume.
    std::string flow_def(std::string const& id, int rateNum, int rateDen,
        std::string const& label, std::string const& description)
    {
        std::ostringstream os;
        os << "{\n"
           << R"(  "id": ")" << id << "\",\n"
           << R"(  "format": "urn:x-nmos:format:data",)" << '\n'
           << R"(  "media_type": "video/smpte291",)" << '\n'
           << R"(  "label": ")" << label << "\",\n"
           << R"(  "description": ")" << description << "\",\n"
           << R"(  "grain_rate": { "numerator": )" << rateNum
           << R"(, "denominator": )" << rateDen << " },\n"
           << R"(  "tags": { "urn:x-nmos:tag:grouphint/v1.0": ["ANC Test Source:Ancillary Data"] })" << '\n'
           << "}\n";
        return os.str();
    }
}  // namespace

int main()
{
    // Line-buffered: stdout to a pipe is block-buffered by default, which holds
    // the startup lines back until the first periodic report — long enough to
    // look like the pod has produced nothing.
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    auto const domain = env_or("MXL_DOMAIN", "/run/mxl/domain");
    auto const flowId = env_or("MXL_FLOW_ID", "a0d20000-0000-0000-0000-000000000001");
    auto const rateNum = std::max(env_int("MXL_GRAIN_RATE_NUM", 30000), 1);
    auto const rateDen = std::max(env_int("MXL_GRAIN_RATE_DEN", 1001), 1);
    // VANC line 9 is where ATC usually sits on HD; nothing here depends on it,
    // but a plausible value makes the probe output look like real ANC.
    auto const line = static_cast<std::uint16_t>(std::max(env_int("MXL_ANC_LINE", 9), 0));
    auto const label = env_or("MXL_LABEL", "MXL ANC Test Timecode");
    auto const description = env_or("MXL_DESCRIPTION",
        "SMPTE ST 12-2 framed ancillary timecode, BCD payload");

    auto* instance = ::mxlCreateInstance(domain.c_str(), "");
    if (instance == nullptr)
    {
        std::fprintf(stderr, "mxlCreateInstance failed for domain %s\n", domain.c_str());
        return 1;
    }

    auto const def = flow_def(flowId, rateNum, rateDen, label, description);
    ::mxlFlowWriter writer = nullptr;
    ::mxlFlowConfigInfo config{};
    bool created = false;
    if (auto const ret = ::mxlCreateFlowWriter(instance, def.c_str(), "", &writer, &config, &created);
        ret != MXL_STATUS_OK)
    {
        std::fprintf(stderr, "mxlCreateFlowWriter failed: %d\n", static_cast<int>(ret));
        ::mxlDestroyInstance(instance);
        return 2;
    }
    std::printf("flow %s %s: data/smpte291 at %d/%d, ANC on line %u\n", flowId.c_str(),
        created ? "created" : "reopened", rateNum, rateDen, static_cast<unsigned>(line));

    // The producer defines the flow's clock, so wall-clock pacing is right here —
    // the opposite of a reader, which must follow this writer's commit head.
    auto const rate = config.common.grainRate;
    std::uint64_t index = ::mxlTimestampToIndex(&rate, ::mxlGetTime());

    // Frames per second, rounded: 30000/1001 counts 0..29, which is what a
    // non-drop-frame timecode does. Drop-frame compensation is deliberately not
    // implemented — see the header comment on payload fidelity.
    auto const fps = std::max<std::uint64_t>(
        (static_cast<std::uint64_t>(rate.numerator) + (rate.denominator / 2)) / rate.denominator, 1);

    std::uint64_t committed = 0;
    std::uint64_t reported = 0;
    while (!g_exit.load(std::memory_order_relaxed))
    {
        ::mxlGrainInfo info{};
        std::uint8_t* payload = nullptr;
        if (auto const ret = ::mxlFlowWriterOpenGrain(writer, index, &info, &payload);
            ret != MXL_STATUS_OK || payload == nullptr)
        {
            std::fprintf(stderr, "mxlFlowWriterOpenGrain=%d at index %llu; realigning\n",
                static_cast<int>(ret), static_cast<unsigned long long>(index));
            index = ::mxlTimestampToIndex(&rate, ::mxlGetTime());
            ::mxlSleepUntil(::mxlGetTime() + 10'000'000ULL);
            continue;
        }

        // Timecode from the grain's own timestamp, not from a counter: the flow's
        // clock is the authority, so a realignment above lands on the right time
        // instead of carrying a drift forward.
        auto const ts = ::mxlIndexToTimestamp(&rate, index);
        auto const secs = ts / 1'000'000'000ULL;
        auto const hours = static_cast<unsigned>((secs / 3600) % 24);
        auto const minutes = static_cast<unsigned>((secs / 60) % 60);
        auto const seconds = static_cast<unsigned>(secs % 60);
        auto const frames = static_cast<unsigned>(index % fps);

        auto const udw = anc::build_atc_udw(hours, minutes, seconds, frames);
        auto const frame =
            anc::build_anc_frame(line, anc::kAtcDid, anc::kAtcSdid, udw.data(), anc::kAtcDataCount);

        if (frame.size() > MXL_DATA_FORMAT_GRAIN_SIZE)
        {
            // Cannot happen with one ATC packet, but a silent truncation into a
            // shared ring is not the failure to discover later.
            std::fprintf(stderr, "frame of %zu bytes exceeds the %d-byte grain\n", frame.size(),
                MXL_DATA_FORMAT_GRAIN_SIZE);
            ::mxlFlowWriterCancelGrain(writer);
            break;
        }

        std::memcpy(payload, frame.data(), frame.size());
        // grainSize carries the payload length; validSlices says the grain is
        // COMPLETE. Those are different things and conflating them makes the flow
        // unreadable: a grain committed with validSlices < totalSlices is treated
        // as still being written, so a reader gets OUT_OF_RANGE_TOO_EARLY at the
        // head and OUT_OF_RANGE_TOO_LATE one grain later, i.e. an empty window it
        // can never read from. mxl-data-probe reads the length off grainSize and
        // only consults validSlices for genuinely partial grains.
        info.grainSize = static_cast<std::uint32_t>(frame.size());
        info.validSlices = info.totalSlices;

        if (auto const ret = ::mxlFlowWriterCommitGrain(writer, &info); ret != MXL_STATUS_OK)
        {
            std::fprintf(stderr, "mxlFlowWriterCommitGrain=%d\n", static_cast<int>(ret));
            ::mxlSleepUntil(::mxlGetTime() + 10'000'000ULL);
            continue;
        }

        ++index;
        ++committed;
        if (committed - reported >= fps * 30)
        {
            reported = committed;
            std::printf("committed %llu grains, timecode %02u:%02u:%02u:%02u\n",
                static_cast<unsigned long long>(committed), hours, minutes, seconds, frames);
        }

        // Hand the next grain's worth of time back before writing it.
        ::mxlSleepUntil(::mxlIndexToTimestamp(&rate, index));
    }

    std::printf("stopping after %llu grains\n", static_cast<unsigned long long>(committed));
    ::mxlReleaseFlowWriter(instance, writer);
    ::mxlDestroyInstance(instance);
    return 0;
}

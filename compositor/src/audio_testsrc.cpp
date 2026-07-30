// mxl-audio-testsrc
//
// Writes a listenable stereo test tone into an MXL AUDIO flow, so the audio
// preview path has something real to carry.
//
// It exists because the audio flow this cluster already had is not audio: the
// tcp-demo flow comes from go-mxl's write-samples, whose payload is an
// incrementing byte ramp (80 81 82 83 ...) for transport-integrity testing. As
// float32 that reads as ~1e38, so mxl-audio-preview correctly refuses to
// publish it and there was no way to hear the pipeline work end to end.
//
// The signal is deliberately easy to check by eye and by ear:
//   - one tone per channel, a fifth apart (440 Hz / 660 Hz by default), so the
//     spectrum shows a distinct peak per channel rather than one shared blob;
//   - a slow tremolo per channel at a DIFFERENT rate each, so the level bars
//     move independently and a channel swap is obvious;
//   - -6 dBFS nominal, well clear of full scale, so a correct read lands
//     mid-meter and a mis-scaled one is unmistakable.
//
// Flow registration is implicit: writing into the domain is enough. The node
// agent's fanotify watch sees the new flow directory, publishes the MxlFlow CR
// with this definition, and renews its origin Lease — so the flow shows up in
// the multiviewer's Operator-flows list on its own.
//
// Env: MXL_DOMAIN (/run/mxl/domain), MXL_FLOW_ID, MXL_SAMPLE_RATE (48000),
// MXL_CHANNELS (2), MXL_TONE_HZ (440), MXL_AMPLITUDE (0.5), MXL_BATCH (480),
// MXL_LABEL, MXL_DESCRIPTION.

#include <algorithm>
#include <atomic>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

#include <mxl/flow.h>
#include <mxl/mxl.h>
#include <mxl/time.h>

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

    double env_double(char const* key, double fallback)
    {
        char const* v = std::getenv(key);
        if (v == nullptr) return fallback;
        try
        {
            return std::stod(v);
        }
        catch (...)
        {
            return fallback;
        }
    }

    // NMOS-shaped flow definition, the same shape the tcp-demo's
    // flow-audio-f32.json carries. Built here rather than mounted from a
    // ConfigMap: mxlCreateFlowWriter takes the document as a string, so the
    // deployment stays a single container with no extra volume.
    std::string flow_def(std::string const& id, int rate, int channels,
        std::string const& label, std::string const& description)
    {
        std::ostringstream os;
        os << "{\n"
           << R"(  "id": ")" << id << "\",\n"
           << R"(  "format": "urn:x-nmos:format:audio",)" << '\n'
           << R"(  "media_type": "audio/float32",)" << '\n'
           << R"(  "label": ")" << label << "\",\n"
           << R"(  "description": ")" << description << "\",\n"
           << R"(  "sample_rate": { "numerator": )" << rate << R"(, "denominator": 1 },)" << '\n'
           << R"(  "channel_count": )" << channels << ",\n"
           << R"(  "bit_depth": 32,)" << '\n'
           << R"(  "tags": { "urn:x-nmos:tag:grouphint/v1.0": ["Audio Test Source:Audio"] })" << '\n'
           << "}\n";
        return os.str();
    }

    struct Tone
    {
        double phase{0.0};      // carrier, radians
        double step{0.0};       // radians per sample
        double lfoPhase{0.0};
        double lfoStep{0.0};
    };
}  // namespace

int main()
{
    // Line-buffered: stdout to a pipe is block-buffered by default, which held
    // the startup lines back until the first periodic report 30s later — long
    // enough to look like the pod had produced nothing.
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    auto const domain = env_or("MXL_DOMAIN", "/run/mxl/domain");
    auto const flowId = env_or("MXL_FLOW_ID", "a0d10000-0000-0000-0000-000000000001");
    auto const rateHz = std::max(env_int("MXL_SAMPLE_RATE", 48000), 8000);
    auto const channels = std::min(std::max(env_int("MXL_CHANNELS", 2), 1), 8);
    auto const toneHz = env_double("MXL_TONE_HZ", 440.0);
    auto const amplitude = std::min(std::max(env_double("MXL_AMPLITUDE", 0.5), 0.0), 1.0);
    auto const label = env_or("MXL_LABEL", "MXL Audio Test Tone");
    auto const description = env_or("MXL_DESCRIPTION", "Stereo test tone, 440/660 Hz with tremolo");
    auto batch = static_cast<std::uint32_t>(std::max(env_int("MXL_BATCH", 480), 1));

    auto* instance = ::mxlCreateInstance(domain.c_str(), "");
    if (instance == nullptr)
    {
        std::fprintf(stderr, "mxlCreateInstance failed for domain %s\n", domain.c_str());
        return 1;
    }

    auto const def = flow_def(flowId, rateHz, channels, label, description);
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
    std::printf("flow %s %s: %d ch @ %d Hz, tone %.1f/%.1f Hz, %.2f amplitude\n",
        flowId.c_str(), created ? "created" : "reopened", channels, rateHz, toneHz,
        toneHz * 1.5, amplitude);

    std::size_t maxWrite = 0;
    ::mxlFlowWriterGetMaxWriteLengthSamples(writer, &maxWrite);
    if (maxWrite > 0) batch = std::min<std::uint32_t>(batch, static_cast<std::uint32_t>(maxWrite));
    std::printf("writing %u samples per commit (max %zu)\n", batch, maxWrite);

    // The producer defines the flow's clock, so wall-clock pacing is right here
    // — the opposite of the reader, which must follow this writer's commit head.
    auto const rate = config.common.grainRate;
    std::uint64_t index = ::mxlTimestampToIndex(&rate, ::mxlGetTime());

    std::vector<Tone> tones(static_cast<std::size_t>(channels));
    for (int c = 0; c < channels; ++c)
    {
        // A fifth up per channel so each has its own spectral peak, and a
        // different tremolo rate so the bars never move in lockstep.
        double const f = toneHz * (1.0 + 0.5 * c);
        tones[static_cast<std::size_t>(c)].step = 2.0 * M_PI * f / rateHz;
        tones[static_cast<std::size_t>(c)].lfoStep =
            2.0 * M_PI * (0.13 + 0.06 * c) / rateHz;
    }

    std::uint64_t committed = 0;
    std::uint64_t reported = 0;
    while (!g_exit.load(std::memory_order_relaxed))
    {
        ::mxlMutableWrappedMultiBufferSlice slices{};
        if (auto const ret = ::mxlFlowWriterOpenSamples(writer, index, batch, &slices);
            ret != MXL_STATUS_OK)
        {
            std::fprintf(stderr, "mxlFlowWriterOpenSamples=%d at index %llu; realigning\n",
                static_cast<int>(ret), static_cast<unsigned long long>(index));
            index = ::mxlTimestampToIndex(&rate, ::mxlGetTime());
            ::mxlSleepUntil(::mxlGetTime() + 10'000'000ULL);
            continue;
        }

        // Planar, one ring buffer per channel: channel c sits `stride` bytes on
        // from channel 0, and the two fragments cover a batch that straddles the
        // buffer's wraparound point. Same layout the reader walks.
        std::size_t written = 0;
        for (auto const& fr : slices.base.fragments)
        {
            if (fr.pointer == nullptr || fr.size == 0) continue;
            auto* bytes = static_cast<std::uint8_t*>(fr.pointer);
            std::size_t const n = fr.size / sizeof(float);
            for (std::size_t s = 0; s < n; ++s)
            {
                for (int c = 0; c < channels; ++c)
                {
                    auto& t = tones[static_cast<std::size_t>(c)];
                    // Tremolo between ~0.35 and 1.0 of nominal: clearly moving
                    // on a meter without ever touching full scale.
                    double const env = 0.35 + 0.65 * (0.5 + 0.5 * std::sin(t.lfoPhase));
                    auto const v = static_cast<float>(amplitude * env * std::sin(t.phase));
                    std::memcpy(bytes + (static_cast<std::size_t>(c) * slices.stride)
                            + (s * sizeof(float)),
                        &v, sizeof(float));

                    // Phase accumulates rather than being recomputed from the
                    // absolute index: that index is epoch-derived and ~1e14, so
                    // freq*index/rate would lose the fractional precision the
                    // tone's continuity depends on.
                    t.phase += t.step;
                    if (t.phase > 2.0 * M_PI) t.phase -= 2.0 * M_PI;
                    t.lfoPhase += t.lfoStep;
                    if (t.lfoPhase > 2.0 * M_PI) t.lfoPhase -= 2.0 * M_PI;
                }
            }
            written += n;
        }

        if (auto const ret = ::mxlFlowWriterCommitSamples(writer); ret != MXL_STATUS_OK)
        {
            std::fprintf(stderr, "mxlFlowWriterCommitSamples=%d\n", static_cast<int>(ret));
            ::mxlFlowWriterCancelSamples(writer);
            ::mxlSleepUntil(::mxlGetTime() + 10'000'000ULL);
            continue;
        }

        index += written;
        committed += written;
        if (committed - reported >= static_cast<std::uint64_t>(rateHz) * 30)
        {
            reported = committed;
            std::printf("committed %llu samples (%llus of audio)\n",
                static_cast<unsigned long long>(committed),
                static_cast<unsigned long long>(committed / rateHz));
            std::fflush(stdout);
        }

        // Hand the next batch's worth of time back before writing it.
        ::mxlSleepUntil(::mxlIndexToTimestamp(&rate, index));
    }

    std::printf("stopping after %llu samples\n", static_cast<unsigned long long>(committed));
    ::mxlReleaseFlowWriter(instance, writer);
    ::mxlDestroyInstance(instance);
    return 0;
}

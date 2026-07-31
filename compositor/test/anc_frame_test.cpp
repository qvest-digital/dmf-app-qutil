// Round-trips anc::build_anc_frame through the parser libmxl's mxl-data-probe
// uses, so the framing is held to the reference reader rather than to my reading
// of RFC 8331. If libmxl changes how it parses ANC grains, this fails at build
// time instead of the demo going quietly wrong.
//
// The parser below is transcribed from mxl/tools/mxl-data-probe/main.cpp
// (Apache-2.0, Contributors to the Media eXchange Layer project) with only the
// mechanical changes needed to drop its fmt/CLI dependencies. It is deliberately
// a copy: a paraphrase would test my understanding of the probe rather than the
// probe itself.
//
// No test framework — the compositor image has none, and one assert helper is
// cheaper than adding Catch2 to a build that ships to a cluster.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#include "../src/anc_frame.h"

namespace probe
{
    constexpr auto const Rfc8331HeaderSizeBytes = std::size_t{6U};
    constexpr auto const Lower8Bits = std::uint16_t{0x00ffU};
    constexpr auto const Lower10Bits = std::uint16_t{0x03ffU};
    constexpr auto const Lower11Bits = std::uint16_t{0x07ffU};

    class BigEndianWordReader
    {
    public:
        constexpr explicit BigEndianWordReader(std::span<std::uint8_t const> bytes)
            : _bytes{bytes}
            , _offset{0}
        {}

        constexpr std::uint16_t read()
        {
            if ((_bytes.size() - _offset) < sizeof(std::uint16_t))
            {
                throw std::runtime_error{"Out-of-bounds read while parsing RFC-8331 ANC payload."};
            }
            auto const value = static_cast<std::uint16_t>(
                (static_cast<std::uint16_t>(_bytes[_offset]) << 8U) | _bytes[_offset + 1]);
            _offset += sizeof(std::uint16_t);
            return value;
        }

        constexpr std::size_t wordOffset() const noexcept { return _offset / sizeof(std::uint16_t); }

    private:
        std::span<std::uint8_t const> _bytes;
        std::size_t _offset;
    };

    class UdwUnpacker
    {
    public:
        constexpr explicit UdwUnpacker(BigEndianWordReader& reader)
            : _reader{&reader}
            , _accumulatedBits{0}
            , _bitCount{0}
        {}

        constexpr std::uint16_t read()
        {
            while (_bitCount < 10U)
            {
                _accumulatedBits = (_accumulatedBits << 16U) | _reader->read();
                _bitCount += 16U;
            }
            auto const value =
                static_cast<std::uint16_t>((_accumulatedBits >> (_bitCount - 10U)) & Lower10Bits);
            _bitCount -= 10U;
            _accumulatedBits &= (1U << _bitCount) - 1U;
            return value;
        }

    private:
        BigEndianWordReader* _reader;
        std::uint32_t _accumulatedBits;
        std::uint32_t _bitCount;
    };

    struct AncElement
    {
        std::uint16_t lineNumber = 0;
        std::uint8_t did = 0;
        std::uint8_t sdid = 0;
        std::uint8_t dataCount = 0;
        std::vector<std::uint8_t> udw;
    };

    struct AncFrame
    {
        std::uint16_t length = 0;
        std::uint8_t ancCount = 0;
        std::vector<AncElement> elements;
    };

    AncFrame parseAncFrame(std::span<std::uint8_t const> payload)
    {
        if (payload.size() < Rfc8331HeaderSizeBytes)
        {
            throw std::runtime_error{"Grain payload is too small to contain an RFC-8331 ANC header."};
        }

        auto reader = BigEndianWordReader{payload};

        auto frame = AncFrame{};
        frame.length = reader.read();
        auto const word1 = reader.read();
        frame.ancCount = static_cast<std::uint8_t>(word1 >> 8U);
        (void)reader.read();

        auto const packetSize = static_cast<std::size_t>(frame.length) + Rfc8331HeaderSizeBytes;
        if (packetSize > payload.size())
        {
            throw std::runtime_error{"RFC-8331 Length field exceeds the available grain payload."};
        }

        for (auto i = std::uint8_t{0}; i < frame.ancCount; ++i)
        {
            if ((reader.wordOffset() % 2U) == 0U)
            {
                (void)reader.read();
            }

            auto element = AncElement{};
            auto const word0 = reader.read();
            (void)reader.read();
            auto const word2 = reader.read();
            auto const word3 = reader.read();

            element.lineNumber = static_cast<std::uint16_t>((word0 >> 4U) & Lower11Bits);
            element.did = static_cast<std::uint8_t>((word2 >> 6U) & Lower8Bits);
            element.sdid = static_cast<std::uint8_t>(
                ((word2 & 0x000fU) << 4U) | ((word3 >> 12U) & 0x000fU));
            element.dataCount = static_cast<std::uint8_t>((word3 >> 2U) & Lower8Bits);
            element.udw.reserve(element.dataCount);

            auto unpacker = UdwUnpacker{reader};
            for (auto word = std::uint8_t{0}; word < element.dataCount; ++word)
            {
                element.udw.push_back(static_cast<std::uint8_t>(unpacker.read() & Lower8Bits));
            }

            (void)unpacker.read();
            frame.elements.push_back(std::move(element));
        }

        return frame;
    }
}  // namespace probe

namespace
{
    int g_failures = 0;

    void check(bool ok, std::string const& what)
    {
        if (!ok)
        {
            std::printf("  FAIL  %s\n", what.c_str());
            ++g_failures;
        }
    }

    template<typename A, typename B>
    void check_eq(A actual, B expected, std::string const& what)
    {
        if (static_cast<std::uint64_t>(actual) != static_cast<std::uint64_t>(expected))
        {
            std::printf("  FAIL  %s: got %llu, want %llu\n", what.c_str(),
                static_cast<unsigned long long>(actual), static_cast<unsigned long long>(expected));
            ++g_failures;
        }
    }

    /// Builds an ATC frame for one timecode and parses it back with the probe.
    probe::AncFrame roundTrip(unsigned h, unsigned m, unsigned s, unsigned f, std::uint16_t line = 9)
    {
        auto const udw = anc::build_atc_udw(h, m, s, f);
        auto const frame =
            anc::build_anc_frame(line, anc::kAtcDid, anc::kAtcSdid, udw.data(), anc::kAtcDataCount);
        return probe::parseAncFrame(std::span<std::uint8_t const>{frame.data(), frame.size()});
    }
}  // namespace

int main()
{
    std::printf("anc_frame_test\n");

    // The probe reads back exactly one ATC element, with the identifiers it uses
    // to label the packet.
    {
        auto const parsed = roundTrip(13, 45, 7, 22);
        check_eq(parsed.ancCount, 1, "ANC_Count");
        check_eq(parsed.elements.size(), 1, "element count");
        if (!parsed.elements.empty())
        {
            auto const& e = parsed.elements.front();
            check_eq(e.did, anc::kAtcDid, "DID");
            check_eq(e.sdid, anc::kAtcSdid, "SDID");
            check_eq(e.dataCount, anc::kAtcDataCount, "Data_Count");
            check_eq(e.lineNumber, 9, "line number");
            check_eq(e.udw.size(), anc::kAtcDataCount, "UDW count");
        }
    }

    // The timecode survives as BCD, one field per word — this is the property the
    // probe's UDW dump is read against.
    {
        auto const parsed = roundTrip(13, 45, 7, 22);
        auto const& udw = parsed.elements.front().udw;
        check_eq(udw[0], 0x13, "hours BCD");
        check_eq(udw[1], 0x45, "minutes BCD");
        check_eq(udw[2], 0x07, "seconds BCD");
        check_eq(udw[3], 0x22, "frames BCD");
        for (std::size_t i = 4; i < udw.size(); ++i) check_eq(udw[i], 0, "reserved UDW " + std::to_string(i));
    }

    // Boundaries: midnight and the last representable second, where a BCD or
    // modulo slip would show up.
    {
        auto const zero = roundTrip(0, 0, 0, 0).elements.front().udw;
        check_eq(zero[0], 0x00, "midnight hours");
        check_eq(zero[3], 0x00, "midnight frames");

        auto const last = roundTrip(23, 59, 59, 29).elements.front().udw;
        check_eq(last[0], 0x23, "23h BCD");
        check_eq(last[1], 0x59, "59m BCD");
        check_eq(last[2], 0x59, "59s BCD");
        check_eq(last[3], 0x29, "29f BCD");
    }

    // Line number is 11 bits; the top of that range must not bleed into the C bit
    // or the horizontal offset.
    {
        check_eq(roundTrip(1, 2, 3, 4, 0).elements.front().lineNumber, 0, "line 0");
        check_eq(roundTrip(1, 2, 3, 4, 2047).elements.front().lineNumber, 2047, "line 2047");
    }

    // Length must describe the packet bytes that follow the 6-byte header, or the
    // probe rejects the frame outright.
    {
        auto const udw = anc::build_atc_udw(1, 2, 3, 4);
        auto const frame =
            anc::build_anc_frame(9, anc::kAtcDid, anc::kAtcSdid, udw.data(), anc::kAtcDataCount);
        auto const declared =
            static_cast<std::size_t>((frame[0] << 8) | frame[1]) + anc::kRfc8331HeaderBytes;
        check_eq(declared, frame.size(), "Length + header == frame size");
        // One ATC packet has to fit a data grain with room to spare.
        check(frame.size() <= 4096, "frame fits a 4096-byte grain");
    }

    // SMPTE 291 parity: b8 makes b0..b8 even, and b9 is b8 inverted. Note that
    // this does NOT make b0..b9 uniformly odd or even — the pair alternates — so
    // the invariant has to be stated over b0..b8.
    {
        for (unsigned v = 0; v < 256; ++v)
        {
            auto const w = anc::anc_word(static_cast<std::uint8_t>(v));
            check_eq(w & 0xffU, v, "word carries its value");
            unsigned ones = 0;
            for (int b = 0; b <= 8; ++b) ones += (w >> b) & 1U;
            check(((ones & 1U) == 0U), "even parity across b0..b8 for value " + std::to_string(v));
            check((((w >> 9) & 1U) != ((w >> 8) & 1U)), "b9 inverts b8 for " + std::to_string(v));
        }
    }

    // anc_frame.h's own parser — the one the ANC preview endpoint serves from —
    // must agree with the probe's on every field. Two parsers that drift apart
    // would mean the UI shows something the reference tool does not.
    {
        struct Case
        {
            unsigned h, m, s, f;
            std::uint16_t line;
        };
        for (auto const& c : {Case{13, 45, 7, 22, 9}, Case{0, 0, 0, 0, 0},
                 Case{23, 59, 59, 29, 2047}, Case{6, 30, 15, 11, 21}})
        {
            auto const udw = anc::build_atc_udw(c.h, c.m, c.s, c.f);
            auto const frame = anc::build_anc_frame(
                c.line, anc::kAtcDid, anc::kAtcSdid, udw.data(), anc::kAtcDataCount);

            auto const ref =
                probe::parseAncFrame(std::span<std::uint8_t const>{frame.data(), frame.size()});
            auto const mine = anc::parse_anc_frame(frame.data(), frame.size());

            auto const tag = std::to_string(c.h) + ":" + std::to_string(c.m);
            if (!mine.has_value())
            {
                check(false, "anc_frame parser accepted the frame (" + tag + ")");
                continue;
            }
            check_eq(mine->ancCount, ref.ancCount, "ancCount agrees (" + tag + ")");
            check_eq(mine->elements.size(), ref.elements.size(), "element count agrees (" + tag + ")");
            if (mine->elements.size() == ref.elements.size() && !ref.elements.empty())
            {
                auto const& a = mine->elements.front();
                auto const& b = ref.elements.front();
                check_eq(a.line, b.lineNumber, "line agrees (" + tag + ")");
                check_eq(a.did, b.did, "DID agrees (" + tag + ")");
                check_eq(a.sdid, b.sdid, "SDID agrees (" + tag + ")");
                check_eq(a.dataCount, b.dataCount, "Data_Count agrees (" + tag + ")");
                check_eq(a.udw.size(), b.udw.size(), "UDW count agrees (" + tag + ")");
                for (std::size_t i = 0; i < a.udw.size() && i < b.udw.size(); ++i)
                {
                    check_eq(a.udw[i], b.udw[i], "UDW " + std::to_string(i) + " agrees (" + tag + ")");
                }
                // And the decode the UI will actually display.
                char want[16];
                std::snprintf(want, sizeof(want), "%02u:%02u:%02u:%02u", c.h, c.m, c.s, c.f);
                check(anc::atc_timecode_bcd(a) == std::string{want},
                    "timecode decodes to " + std::string{want});
            }
        }
    }

    // Malformed input must be refused, not read past the end: this parses bytes
    // out of a shared ring that a half-written producer can leave inconsistent.
    {
        std::uint8_t tiny[3] = {0, 0, 0};
        check(!anc::parse_anc_frame(tiny, sizeof(tiny)).has_value(), "refuses a short buffer");
        check(!anc::parse_anc_frame(nullptr, 0).has_value(), "refuses a null buffer");

        // Length field claiming more than the buffer holds.
        auto const udw = anc::build_atc_udw(1, 2, 3, 4);
        auto bad = anc::build_anc_frame(9, anc::kAtcDid, anc::kAtcSdid, udw.data(), anc::kAtcDataCount);
        bad[0] = 0xff;
        bad[1] = 0xff;
        check(!anc::parse_anc_frame(bad.data(), bad.size()).has_value(), "refuses an oversized Length");

        // Truncated mid-payload: the declared count outruns the bytes present.
        auto truncated = anc::build_anc_frame(9, anc::kAtcDid, anc::kAtcSdid, udw.data(), anc::kAtcDataCount);
        truncated.resize(truncated.size() - 6);
        truncated[0] = static_cast<std::uint8_t>((truncated.size() - anc::kRfc8331HeaderBytes) >> 8);
        truncated[1] = static_cast<std::uint8_t>((truncated.size() - anc::kRfc8331HeaderBytes) & 0xffU);
        check(!anc::parse_anc_frame(truncated.data(), truncated.size()).has_value(),
            "refuses a truncated payload");
    }

    if (g_failures == 0)
    {
        std::printf("  all checks passed\n");
        return 0;
    }
    std::printf("  %d check(s) failed\n", g_failures);
    return 1;
}

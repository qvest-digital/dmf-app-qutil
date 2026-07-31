// RFC 8331 ancillary-data framing, as MXL stores it in a `video/smpte291` grain.
//
// Header-only and free of any libmxl dependency, so the framing can be tested on
// its own — see compositor/test/anc_frame_test.cpp, which round-trips these
// frames through the parser from libmxl's mxl-data-probe. The writer that puts
// them into a flow is anc_testsrc.cpp; the layout is documented there.

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

namespace anc
{
    /// SMPTE ST 12-2 Ancillary Time Code. mxl-data-probe's DID table names this
    /// pair, so a correctly framed packet is self-describing there.
    constexpr std::uint8_t kAtcDid = 0x60;
    constexpr std::uint8_t kAtcSdid = 0x60;
    /// ST 12-2 fixes the ATC data count at 16 words. Kept even though only the
    /// first four carry anything, so the packet's shape is the real one.
    constexpr std::uint8_t kAtcDataCount = 16;
    /// Bytes of RFC 8331 header that MXL actually stores: Length onward.
    constexpr std::size_t kRfc8331HeaderBytes = 6;

    /// One 10-bit SMPTE 291 word: the value in b0..b7, even parity over those in
    /// b8, and b9 as its inverse.
    inline std::uint16_t anc_word(std::uint8_t value)
    {
        unsigned ones = 0;
        for (int bit = 0; bit < 8; ++bit) ones += static_cast<unsigned>((value >> bit) & 1U);
        std::uint16_t const b8 = (ones & 1U) ? 1U : 0U;
        std::uint16_t const b9 = b8 ? 0U : 1U;
        return static_cast<std::uint16_t>((b9 << 9) | (b8 << 8) | value);
    }

    /// Two BCD digits, so 13 becomes 0x13 and reads as "13" in a hex dump.
    inline std::uint8_t bcd(unsigned value)
    {
        return static_cast<std::uint8_t>((((value / 10U) % 10U) << 4) | (value % 10U));
    }

    /// Appends bit fields into a big-endian bit stream, MSB first.
    class WordPacker
    {
    public:
        void push_bits(std::uint32_t value, unsigned bits)
        {
            _bits = (_bits << bits) | (value & ((1U << bits) - 1U));
            _count += bits;
            while (_count >= 16)
            {
                _count -= 16;
                emit(static_cast<std::uint16_t>((_bits >> _count) & 0xffffU));
            }
        }

        void push(std::uint16_t word10) { push_bits(word10, 10); }

        /// Zero-pads to the next 16-bit boundary and returns the bytes.
        std::vector<std::uint8_t> finish()
        {
            if (_count > 0)
            {
                emit(static_cast<std::uint16_t>((_bits << (16 - _count)) & 0xffffU));
                _count = 0;
            }
            return std::move(_out);
        }

    private:
        void emit(std::uint16_t w)
        {
            _out.push_back(static_cast<std::uint8_t>(w >> 8));
            _out.push_back(static_cast<std::uint8_t>(w & 0xffU));
        }

        std::vector<std::uint8_t> _out;
        std::uint32_t _bits{0};
        std::uint32_t _count{0};
    };

    inline void push_be16(std::vector<std::uint8_t>& out, std::uint16_t v)
    {
        out.push_back(static_cast<std::uint8_t>(v >> 8));
        out.push_back(static_cast<std::uint8_t>(v & 0xffU));
    }

    /// The 16 ATC user data words for one timecode: BCD per field, one field per
    /// word. Deliberately not the ST 12M-2 bit layout — see anc_testsrc.cpp.
    inline std::array<std::uint8_t, kAtcDataCount> build_atc_udw(unsigned hours,
        unsigned minutes, unsigned seconds, unsigned frames)
    {
        std::array<std::uint8_t, kAtcDataCount> udw{};
        udw[0] = bcd(hours);
        udw[1] = bcd(minutes);
        udw[2] = bcd(seconds);
        udw[3] = bcd(frames);
        return udw;
    }

    /// One RFC 8331 frame — as MXL stores it, from the Length field on — carrying
    /// a single ANC packet.
    inline std::vector<std::uint8_t> build_anc_frame(std::uint16_t lineNumber, std::uint8_t did,
        std::uint8_t sdid, std::uint8_t const* udw, std::uint8_t dataCount)
    {
        // Packet data first, so Length is known before the header is written.
        std::vector<std::uint8_t> packet;
        // C=0 (the ANC is not in the chroma stream), the line, then the top 4 bits
        // of a zero horizontal offset.
        push_be16(packet, static_cast<std::uint16_t>((lineNumber & 0x07ffU) << 4));
        // Rest of the horizontal offset, S=0, StreamNum=0.
        push_be16(packet, 0);

        // DID, SDID and Data_Count are 10-bit words like the payload, and the
        // checksum covers the low 9 bits of every one of them.
        WordPacker packer;
        std::uint32_t checksum = 0;
        auto emit = [&](std::uint8_t value)
        {
            auto const w = anc_word(value);
            checksum += (w & 0x01ffU);
            packer.push(w);
        };
        emit(did);
        emit(sdid);
        emit(dataCount);
        // DID, SDID and Data_Count are 30 bits; pad to 32 so the user data words
        // begin at the top of the next 16-bit word. libmxl's mxl-data-probe reads
        // them that way — its UdwUnpacker starts on a fresh word after the four
        // packet-header words — so packing UDW into the two leftover bits here
        // would shift every value by 2 bits and the probe would show garbage.
        packer.push_bits(0, 2);
        for (std::uint8_t i = 0; i < dataCount; ++i) emit(udw[i]);

        // Checksum: low 9 bits of the sum, b9 its inverse. Not b8-parity like the
        // data words — ST 291 defines it this way.
        auto const sum9 = static_cast<std::uint16_t>(checksum & 0x01ffU);
        auto const csB9 = static_cast<std::uint16_t>(((sum9 >> 8) & 1U) ? 0U : 1U);
        packer.push(static_cast<std::uint16_t>((csB9 << 9) | sum9));

        auto const words = packer.finish();
        packet.insert(packet.end(), words.begin(), words.end());

        std::vector<std::uint8_t> frame;
        push_be16(frame, static_cast<std::uint16_t>(packet.size()));  // Length
        push_be16(frame, static_cast<std::uint16_t>(1U << 8));        // ANC_Count = 1
        push_be16(frame, 0);                                          // reserved
        frame.insert(frame.end(), packet.begin(), packet.end());
        return frame;
    }

    // ── Reading back ────────────────────────────────────────────────────────
    // The mirror image of the builder, laid out to match libmxl's mxl-data-probe
    // word for word — including the alignment rules the builder documents. Used
    // by the ANC preview endpoint, and checked against the probe's own parser in
    // the round-trip test, so the two cannot drift apart silently.
    //
    // Every read is bounds-checked: this parses whatever is sitting in a shared
    // ring buffer, which a half-written or foreign producer can leave malformed.

    struct AncElement
    {
        std::uint16_t line = 0;
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

    class BitReader
    {
    public:
        BitReader(std::uint8_t const* data, std::size_t size)
            : _data{data}
            , _size{size}
        {}

        bool read16(std::uint16_t& out)
        {
            if (_size - _offset < 2) return false;
            out = static_cast<std::uint16_t>((_data[_offset] << 8) | _data[_offset + 1]);
            _offset += 2;
            return true;
        }

        std::size_t wordOffset() const { return _offset / 2; }

        /// Ten-bit words, MSB first, starting from the current 16-bit boundary.
        bool read10(std::uint16_t& out)
        {
            while (_bitCount < 10)
            {
                std::uint16_t w = 0;
                if (!read16(w)) return false;
                _acc = (_acc << 16) | w;
                _bitCount += 16;
            }
            _bitCount -= 10;
            out = static_cast<std::uint16_t>((_acc >> _bitCount) & 0x03ffU);
            _acc &= (1U << _bitCount) - 1U;
            return true;
        }

        /// Drops any partial 10-bit accumulation, so the next read10 starts on a
        /// fresh 16-bit word — matching where the probe begins each element's UDW.
        void realign()
        {
            _acc = 0;
            _bitCount = 0;
        }

    private:
        std::uint8_t const* _data;
        std::size_t _size;
        std::size_t _offset{0};
        std::uint32_t _acc{0};
        std::uint32_t _bitCount{0};
    };

    inline std::optional<AncFrame> parse_anc_frame(std::uint8_t const* data, std::size_t size)
    {
        if (data == nullptr || size < kRfc8331HeaderBytes) return std::nullopt;

        BitReader r{data, size};
        AncFrame frame;
        std::uint16_t w = 0;
        if (!r.read16(frame.length)) return std::nullopt;
        if (!r.read16(w)) return std::nullopt;
        frame.ancCount = static_cast<std::uint8_t>(w >> 8);
        if (!r.read16(w)) return std::nullopt;

        if (static_cast<std::size_t>(frame.length) + kRfc8331HeaderBytes > size) return std::nullopt;

        for (std::uint8_t i = 0; i < frame.ancCount; ++i)
        {
            // The probe pads each element to a 32-bit boundary this way.
            if ((r.wordOffset() % 2) == 0 && !r.read16(w)) return std::nullopt;

            std::uint16_t w0 = 0;
            std::uint16_t w2 = 0;
            std::uint16_t w3 = 0;
            if (!r.read16(w0) || !r.read16(w) || !r.read16(w2) || !r.read16(w3))
            {
                return std::nullopt;
            }

            AncElement e;
            e.line = static_cast<std::uint16_t>((w0 >> 4) & 0x07ffU);
            e.did = static_cast<std::uint8_t>((w2 >> 6) & 0x00ffU);
            e.sdid = static_cast<std::uint8_t>(((w2 & 0x000fU) << 4) | ((w3 >> 12) & 0x000fU));
            e.dataCount = static_cast<std::uint8_t>((w3 >> 2) & 0x00ffU);

            // UDW start on the next whole word, not in w3's leftover two bits.
            r.realign();
            e.udw.reserve(e.dataCount);
            for (std::uint8_t n = 0; n < e.dataCount; ++n)
            {
                std::uint16_t word = 0;
                if (!r.read10(word)) return std::nullopt;
                e.udw.push_back(static_cast<std::uint8_t>(word & 0x00ffU));
            }
            std::uint16_t checksum = 0;
            if (!r.read10(checksum)) return std::nullopt;

            frame.elements.push_back(std::move(e));
        }
        return frame;
    }

    /// The DID/SDID pairs libmxl's probe names, so the UI can label a packet
    /// rather than showing two bare hex bytes.
    inline char const* anc_name(std::uint8_t did, std::uint8_t sdid)
    {
        struct Entry
        {
            std::uint8_t did;
            std::uint8_t sdid;
            char const* name;
        };
        static constexpr Entry kNames[] = {
            {0x41, 0x01, "SMPTE ST 352 Video Payload ID"           },
            {0x41, 0x05, "SMPTE ST 2016 Active Format Description" },
            {0x41, 0x07, "ANSI/SCTE 104 messages"                  },
            {0x41, 0x08, "SMPTE ST 2031 VBI data"                  },
            {0x41, 0x0C, "SMPTE ST 2108-1 HDR/WCG metadata"        },
            {0x43, 0x02, "OP-47 Subtitling Distribution Packet"    },
            {0x43, 0x03, "OP-47 VANC multipacket"                  },
            {0x50, 0x01, "Wide Screen Signaling"                   },
            {0x60, 0x60, "SMPTE ST 12-2 Ancillary Time Code"       },
            {0x61, 0x01, "SMPTE ST 334 Caption Distribution Packet"},
            {0x61, 0x02, "SMPTE ST 334 CEA-608 closed captions"    },
        };
        for (auto const& e : kNames)
        {
            if (e.did == did && e.sdid == sdid) return e.name;
        }
        return "";
    }

    /// The timecode this repo's anc-testsrc writes: BCD per field in the first
    /// four user data words. Empty for anything else, including a real ST 12M-2
    /// ATC packet, whose words mean something different — see anc_testsrc.cpp.
    inline std::string atc_timecode_bcd(AncElement const& e)
    {
        if (e.did != kAtcDid || e.sdid != kAtcSdid || e.udw.size() < 4) return {};
        auto twoDigit = [](std::uint8_t v) { return ((v >> 4) & 0x0fU) * 10U + (v & 0x0fU); };
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%02u:%02u:%02u:%02u", twoDigit(e.udw[0]),
            twoDigit(e.udw[1]), twoDigit(e.udw[2]), twoDigit(e.udw[3]));
        return std::string{buf};
    }
}  // namespace anc

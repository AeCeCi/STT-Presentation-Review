import struct
from io import BytesIO
from typing import Any


def wav_duration_seconds(data: bytes) -> float | None:
    try:
        import wave

        with wave.open(BytesIO(data), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
            if frames > 0 and rate > 0:
                return frames / float(rate)
    except Exception:
        return None
    return None


def mp4_duration_seconds(data: bytes) -> float | None:
    containers = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"udta"}

    def walk(start: int, end: int) -> float | None:
        offset = start
        while offset + 8 <= end and offset + 8 <= len(data):
            size = int.from_bytes(data[offset:offset + 4], "big")
            atom_type = data[offset + 4:offset + 8]
            header = 8
            if size == 1 and offset + 16 <= len(data):
                size = int.from_bytes(data[offset + 8:offset + 16], "big")
                header = 16
            elif size == 0:
                size = end - offset
            if size < header or offset + size > len(data):
                break
            payload_start = offset + header
            payload_end = offset + size
            if atom_type == b"mvhd" and payload_start + 20 <= payload_end:
                version = data[payload_start]
                try:
                    if version == 1 and payload_start + 32 <= payload_end:
                        timescale = struct.unpack(">I", data[payload_start + 20:payload_start + 24])[0]
                        duration = struct.unpack(">Q", data[payload_start + 24:payload_start + 32])[0]
                    else:
                        timescale = struct.unpack(">I", data[payload_start + 12:payload_start + 16])[0]
                        duration = struct.unpack(">I", data[payload_start + 16:payload_start + 20])[0]
                    if timescale > 0 and duration > 0:
                        return duration / float(timescale)
                except struct.error:
                    return None
            if atom_type in containers:
                found = walk(payload_start, payload_end)
                if found:
                    return found
            offset += size
        return None

    return walk(0, len(data))


def mp3_duration_seconds(data: bytes) -> float | None:
    if not data:
        return None
    offset = 0
    if data.startswith(b"ID3") and len(data) >= 10:
        tag_size = (
            ((data[6] & 0x7F) << 21)
            | ((data[7] & 0x7F) << 14)
            | ((data[8] & 0x7F) << 7)
            | (data[9] & 0x7F)
        )
        offset = 10 + tag_size
    bitrates = {
        3: {
            3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
            2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
            1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
        },
        2: {
            3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
            2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
            1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
        },
    }
    sample_rates = {
        3: [44100, 48000, 32000, 0],
        2: [22050, 24000, 16000, 0],
        0: [11025, 12000, 8000, 0],
    }
    duration = 0.0
    frames = 0
    i = offset
    while i + 4 <= len(data):
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1
            continue
        header = int.from_bytes(data[i:i + 4], "big")
        version_id = (header >> 19) & 0x3
        layer_bits = (header >> 17) & 0x3
        bitrate_idx = (header >> 12) & 0xF
        sample_idx = (header >> 10) & 0x3
        padding = (header >> 9) & 0x1
        if version_id == 1 or layer_bits == 0:
            i += 1
            continue
        version_key = 3 if version_id == 3 else 2
        layer = 4 - layer_bits
        bitrate = bitrates.get(version_key, {}).get(layer, [0] * 16)[bitrate_idx] * 1000
        sample_rate = sample_rates.get(version_id, [0, 0, 0, 0])[sample_idx]
        if bitrate <= 0 or sample_rate <= 0:
            i += 1
            continue
        samples = 384 if layer == 1 else 1152 if version_key == 3 else 576
        frame_len = int((12 * bitrate / sample_rate + padding) * 4) if layer == 1 else int((144 * bitrate / sample_rate) + padding)
        if frame_len <= 0:
            i += 1
            continue
        duration += samples / sample_rate
        frames += 1
        i += frame_len
    return duration if frames > 3 and duration > 0 else None


def audio_duration_seconds(uploaded_file: Any) -> float | None:
    if not uploaded_file:
        return None
    data = uploaded_file.getvalue()
    name = str(getattr(uploaded_file, "name", "")).lower()
    if name.endswith(".wav"):
        return wav_duration_seconds(data)
    if name.endswith(".mp3"):
        return mp3_duration_seconds(data)
    if name.endswith((".m4a", ".mp4", ".mov", ".aac")):
        return mp4_duration_seconds(data)
    return wav_duration_seconds(data) or mp4_duration_seconds(data) or mp3_duration_seconds(data)

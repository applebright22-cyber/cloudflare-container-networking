import unittest

from protocol import CLOSE, MAX_PAYLOAD_BYTES, OPEN_TCP, decode_frame, encode_frame


class ProtocolTests(unittest.TestCase):
    def test_round_trip_preserves_fields(self):
        wire = encode_frame(OPEN_TCP, "node-1", 0x10203, 7, b"hello", flags=3)
        frame = decode_frame(wire)
        self.assertEqual(frame.frame_type, OPEN_TCP)
        self.assertEqual(frame.node_id, "node-1")
        self.assertEqual(frame.stream_id, 0x10203)
        self.assertEqual(frame.sequence, 7)
        self.assertEqual(frame.flags, 3)
        self.assertEqual(frame.payload, b"hello")

    def test_empty_payload_and_zero_stream(self):
        frame = decode_frame(encode_frame(CLOSE, "n", 0))
        self.assertEqual(frame.payload, b"")
        self.assertEqual(frame.stream_id, 0)

    def test_rejects_bad_magic(self):
        wire = bytearray(encode_frame(CLOSE, "n"))
        wire[0] = ord("X")
        with self.assertRaisesRegex(ValueError, "bad_magic"):
            decode_frame(bytes(wire))

    def test_rejects_truncated_frame(self):
        with self.assertRaisesRegex(ValueError, "truncated"):
            decode_frame(b"RLY")

    def test_rejects_length_mismatch(self):
        wire = encode_frame(CLOSE, "n") + b"extra"
        with self.assertRaisesRegex(ValueError, "length_mismatch"):
            decode_frame(wire)

    def test_rejects_oversized_payload(self):
        with self.assertRaisesRegex(ValueError, "payload_too_large"):
            encode_frame(CLOSE, "n", payload=b"x" * (MAX_PAYLOAD_BYTES + 1))

    def test_rejects_invalid_node_id(self):
        with self.assertRaisesRegex(ValueError, "invalid_node_id"):
            encode_frame(CLOSE, "bad node")


if __name__ == "__main__":
    unittest.main()

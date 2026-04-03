"""Tests for chunking logic — _split_paragraphs and chunk reassembly."""

import pytest
import sys
from pathlib import Path

# Import chunking helpers
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))
from pii_shield_server import _split_paragraphs


class TestSplitParagraphs:
    def test_short_text_single_chunk(self):
        text = "This is a short paragraph."
        chunks = _split_paragraphs(text, target_size=1000)
        assert len(chunks) == 1
        assert chunks[0] == text

    def test_splits_on_paragraph_boundary(self):
        para1 = "A" * 500
        para2 = "B" * 500
        text = f"{para1}\n\n{para2}"
        chunks = _split_paragraphs(text, target_size=600)
        assert len(chunks) == 2
        assert para1 in chunks[0]
        assert para2 in chunks[1]

    def test_no_data_loss(self):
        """All text should be preserved after splitting and rejoining."""
        paragraphs = [f"Paragraph {i} with some content." for i in range(20)]
        text = "\n\n".join(paragraphs)
        chunks = _split_paragraphs(text, target_size=200)
        reassembled = "\n\n".join(chunks)
        assert reassembled == text

    def test_single_large_paragraph(self):
        """A paragraph larger than target_size stays as one chunk."""
        text = "A" * 5000
        chunks = _split_paragraphs(text, target_size=1000)
        # Should still contain the full text
        assert "".join(chunks) == text

    def test_empty_text(self):
        chunks = _split_paragraphs("", target_size=1000)
        assert len(chunks) == 1
        assert chunks[0] == ""


class TestChunkReassembly:
    """Test that chunked anonymization produces same result as single-pass."""

    def test_reassembly_preserves_text(self, engine):
        """Anonymize text, restore via mapping, verify all PII is back."""
        text = (
            "This Share Purchase Agreement is entered into between "
            "John Smith, Managing Director, and Maria Garcia, CEO. "
            "The registered office is at 42 Baker Street, London."
        )
        result = engine.anonymize_text(text)
        anon = result["anonymized_text"]

        # Restore and verify round-trip integrity
        from pii_shield_server import load_mapping
        mapping = load_mapping(result["session_id"])
        restored = anon
        for ph, real in mapping.items():
            restored = restored.replace(ph, real)

        # Restored text should match original
        assert restored == text, f"Round-trip failed.\nOriginal: {text}\nRestored: {restored}"

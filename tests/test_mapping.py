"""Tests for mapping persistence — save/load/TTL."""

import pytest
import time
import json
from pathlib import Path


class TestMappingPersistence:
    def test_save_and_load(self, engine):
        """Save a mapping and load it back."""
        from pii_shield_server import save_mapping, load_mapping

        mapping = {"<PERSON_1>": "John Smith", "<ORG_1>": "Acme Corp."}
        session_id = f"test_{int(time.time() * 1000)}"

        save_mapping(session_id, mapping)
        loaded = load_mapping(session_id)

        assert loaded == mapping

    def test_load_nonexistent(self):
        """Loading a non-existent session returns empty dict."""
        from pii_shield_server import load_mapping

        loaded = load_mapping("nonexistent_session_12345")
        assert loaded == {}

    def test_mapping_from_anonymize(self, engine):
        """anonymize_text creates a valid mapping."""
        from pii_shield_server import load_mapping

        result = engine.anonymize_text("John Smith works at Acme Corp.")
        mapping = load_mapping(result["session_id"])

        assert len(mapping) > 0
        # All values should be strings (real PII)
        for placeholder, real_value in mapping.items():
            assert isinstance(placeholder, str)
            assert isinstance(real_value, str)
            assert placeholder.startswith("<")
            assert placeholder.endswith(">")


class TestReviewData:
    def test_review_stored_after_anonymize(self, engine):
        """Review data is created after anonymization."""
        from pii_shield_server import _get_review

        result = engine.anonymize_text("John Smith from London.")
        review = _get_review(result["session_id"])

        assert review is not None
        assert "entities" in review
        assert "original_text" in review
        assert review["status"] == "pending"

    def test_review_contains_entities(self, engine):
        """Review data includes detected entities with positions."""
        from pii_shield_server import _get_review

        text = "Contact John Smith at john@example.com."
        result = engine.anonymize_text(text)
        review = _get_review(result["session_id"])

        assert len(review["entities"]) > 0
        for e in review["entities"]:
            assert "type" in e
            assert "start" in e
            assert "end" in e
            assert "text" in e

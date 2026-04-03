"""Tests for HITL override logic — _apply_overrides()."""

import pytest
import json


class TestApplyOverrides:
    def _make_entities(self, *specs):
        """Helper: create entity dicts from (type, text, start, end) tuples."""
        return [
            {"type": t, "text": txt, "start": s, "end": e, "score": 0.9, "verified": True}
            for t, txt, s, e in specs
        ]

    def test_remove_by_index(self, engine):
        entities = self._make_entities(
            ("PERSON", "John Smith", 0, 10),
            ("ORGANIZATION", "Acme Corp.", 20, 30),
        )
        overrides = json.dumps({"remove": [0]})
        result = engine._apply_overrides(entities, "John Smith works at Acme Corp.", overrides)
        types = [e["type"] for e in result]
        assert "PERSON" not in types
        assert "ORGANIZATION" in types

    def test_remove_all_matching_text(self, engine):
        """Removing one occurrence removes ALL occurrences of same text+type."""
        text = "John Smith met John Smith at the office."
        entities = self._make_entities(
            ("PERSON", "John Smith", 0, 10),
            ("PERSON", "John Smith", 15, 25),
        )
        overrides = json.dumps({"remove": [0]})
        result = engine._apply_overrides(entities, text, overrides)
        assert len(result) == 0, f"Both 'John Smith' should be removed, got {result}"

    def test_add_entity(self, engine):
        text = "ProjectX is a secret initiative."
        entities = []
        overrides = json.dumps({"add": [{"text": "ProjectX", "type": "ORGANIZATION"}]})
        result = engine._apply_overrides(entities, text, overrides)
        assert len(result) == 1
        assert result[0]["type"] == "ORGANIZATION"
        assert result[0]["text"] == "ProjectX"
        assert result[0]["start"] == 0
        assert result[0]["end"] == 8

    def test_add_finds_all_occurrences(self, engine):
        text = "ProjectX started. Later, ProjectX expanded."
        entities = []
        overrides = json.dumps({"add": [{"text": "ProjectX", "type": "ORGANIZATION"}]})
        result = engine._apply_overrides(entities, text, overrides)
        assert len(result) == 2, f"Should find 2 occurrences, got {result}"

    def test_add_skips_already_covered(self, engine):
        text = "John Smith is here."
        entities = self._make_entities(("PERSON", "John Smith", 0, 10))
        overrides = json.dumps({"add": [{"text": "John Smith", "type": "PERSON"}]})
        result = engine._apply_overrides(entities, text, overrides)
        # Should not duplicate
        assert len(result) == 1

    def test_invalid_overrides_json(self, engine):
        entities = self._make_entities(("PERSON", "John", 0, 4))
        result = engine._apply_overrides(entities, "John is here.", "not valid json{{{")
        # Should return original entities unchanged
        assert len(result) == 1

    def test_combined_add_and_remove(self, engine):
        text = "John Smith works at ProjectX in London."
        entities = self._make_entities(
            ("PERSON", "John Smith", 0, 10),
            ("LOCATION", "London", 32, 38),
        )
        overrides = json.dumps({
            "remove": [1],  # remove London
            "add": [{"text": "ProjectX", "type": "ORGANIZATION"}],
        })
        result = engine._apply_overrides(entities, text, overrides)
        types = [e["type"] for e in result]
        assert "PERSON" in types
        assert "ORGANIZATION" in types
        assert "LOCATION" not in types

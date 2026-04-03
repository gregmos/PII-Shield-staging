"""Tests for anonymization — PIIEngine.anonymize_text()"""

import pytest
import json


class TestAnonymizeText:
    def test_basic_anonymization(self, engine):
        text = (
            "This Agreement is between John Smith, Managing Director of Acme Corp., "
            "and the other parties. Contact: john@acme.com"
        )
        result = engine.anonymize_text(text)
        anon = result["anonymized_text"]

        # Email should always be caught by pattern recognizer
        assert "john@acme.com" not in anon
        assert result["session_id"]
        assert result["entities_confirmed"] > 0

    def test_placeholder_format(self, engine):
        result = engine.anonymize_text("Contact Maria Garcia at maria@example.com.")
        anon = result["anonymized_text"]

        # Check placeholder format: <TYPE_N>
        import re
        placeholders = re.findall(r"<[A-Z_]+_\d+[a-z]?>", anon)
        assert len(placeholders) >= 1, f"Expected placeholders, got: {anon}"

    def test_prefix(self, engine):
        text = "This contract is signed by John Smith, Director of Operations, on behalf of the Company."
        result = engine.anonymize_text(text, prefix="D1")
        anon = result["anonymized_text"]
        if result["entities_confirmed"] > 0:
            assert "<D1_" in anon, f"Expected prefix D1, got: {anon}"

    def test_mapping_reversible(self, engine):
        text = "John Smith works at Acme Corp. in London."
        result = engine.anonymize_text(text)
        anon = result["anonymized_text"]

        # Load mapping and reverse
        from pii_shield_server import load_mapping
        mapping = load_mapping(result["session_id"])

        restored = anon
        for placeholder, real in mapping.items():
            restored = restored.replace(placeholder, real)

        # Original names should be back
        assert "John Smith" in restored or "John" in restored
        assert "London" in restored or "Acme" in restored

    def test_empty_text(self, engine):
        result = engine.anonymize_text("")
        assert result["entities_confirmed"] == 0
        assert result["anonymized_text"] == ""

    def test_no_pii(self, engine):
        result = engine.anonymize_text("The weather is nice today.")
        assert result["entities_confirmed"] == 0
        assert result["anonymized_text"] == "The weather is nice today."

    def test_multiple_entities_same_type(self, engine):
        text = (
            "The parties to this Share Purchase Agreement are: "
            "John Smith (hereinafter 'the Seller'), "
            "Maria Garcia (hereinafter 'the Buyer'), and "
            "Robert Chen (hereinafter 'the Guarantor')."
        )
        result = engine.anonymize_text(text)
        anon = result["anonymized_text"]

        if result["entities_confirmed"] >= 2:
            import re
            person_placeholders = re.findall(r"<PERSON_(\d+)[a-z]?>", anon)
            assert len(set(person_placeholders)) >= 2, f"Expected multiple person placeholders, got: {anon}"


class TestEntityOverrides:
    def test_add_entity(self, engine):
        text = "ProjectX is a secret initiative by John Smith."
        overrides = json.dumps({"add": [{"text": "ProjectX", "type": "ORGANIZATION"}]})
        result = engine.anonymize_text(text, entity_overrides=overrides)
        anon = result["anonymized_text"]
        assert "ProjectX" not in anon, f"ProjectX should be anonymized, got: {anon}"

    def test_remove_entity(self, engine):
        text = "John Smith works in London."
        # First anonymize to find entity indices
        result1 = engine.anonymize_text(text)

        # Find the index of the LOCATION entity to remove
        from pii_shield_server import _get_review
        review = _get_review(result1["session_id"])
        location_indices = [i for i, e in enumerate(review["entities"])
                           if e["type"] == "LOCATION" and e.get("verified", False)]

        if location_indices:
            overrides = json.dumps({"remove": location_indices})
            result2 = engine.anonymize_text(text, entity_overrides=overrides)
            anon = result2["anonymized_text"]
            assert "London" in anon, f"London should NOT be anonymized after removal, got: {anon}"

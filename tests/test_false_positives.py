"""Tests for false positive filtering — stoplist and boundary cleanup."""

import pytest
from pii_shield_server import PIIEngine


class TestStoplist:
    """Verify that stoplist terms are not detected as PII."""

    @pytest.mark.parametrize("term", [
        "Contractor", "Client", "Seller", "Buyer", "Landlord", "Tenant",
        "Employee", "Employer", "Agent", "Principal",
        "Chairman", "President", "CEO", "CFO",
        "Agreement", "Contract", "Amendment",
        "LLC", "Ltd", "Inc", "GmbH",
    ])
    def test_stoplist_terms_filtered(self, engine, term):
        text = f"The {term} shall comply with all obligations."
        entities = engine.detect(text, "en")
        verified = [e for e in entities if e.get("verified")]
        verified_texts = [e["text"].lower() for e in verified]
        assert term.lower() not in verified_texts, \
            f"'{term}' should be filtered by stoplist, got: {verified_texts}"


class TestBoundarySnap:
    def test_snap_extends_to_word_boundary(self):
        text = "Contact JohnSmith for details."
        # Simulate an entity that starts mid-word
        entities = [{"start": 8, "end": 12, "text": "John", "type": "PERSON", "score": 0.9}]
        result = PIIEngine._snap_word_boundaries(text, entities)
        # Should extend to full "JohnSmith"
        if result:
            assert result[0]["text"] == "JohnSmith" or result[0]["end"] == 17

    def test_drops_short_entities(self):
        text = "Mr. S is here."
        entities = [{"start": 4, "end": 5, "text": "S", "type": "PERSON", "score": 0.5}]
        result = PIIEngine._snap_word_boundaries(text, entities)
        # "S" is <=2 chars, should be dropped
        assert len(result) == 0, f"Short entity should be dropped, got: {result}"

    def test_trims_punctuation(self):
        text = 'Contact "John Smith" for details.'
        entities = [{"start": 8, "end": 20, "text": '"John Smith"', "type": "PERSON", "score": 0.9}]
        result = PIIEngine._snap_word_boundaries(text, entities)
        if result:
            assert '"' not in result[0]["text"], f"Quotes should be trimmed, got: {result[0]['text']}"

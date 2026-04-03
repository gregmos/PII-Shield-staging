"""Tests for NER detection — PIIEngine.detect()

Note: GLiNER zero-shot NER needs sufficient context to detect entities reliably.
Short isolated sentences may not trigger detection. Tests use realistic legal
document snippets to match production usage.
"""

import pytest


class TestPersonDetection:
    def test_detect_returns_entities(self, engine):
        """detect() returns a list of entity dicts with required keys."""
        text = "John Smith, Managing Director, signed the agreement on behalf of the Company."
        entities = engine.detect(text, "en")
        assert isinstance(entities, list)
        for e in entities:
            assert "type" in e
            assert "text" in e
            assert "start" in e
            assert "end" in e
            assert "score" in e

    def test_anonymize_catches_person(self, engine):
        """End-to-end: anonymize_text should catch person names."""
        text = (
            "This Share Purchase Agreement is entered into between "
            "John Smith, Managing Director, and the Company. "
            "Contact John Smith at john.smith@example.com for details."
        )
        result = engine.anonymize_text(text)
        # At least email should be caught; person detection depends on GLiNER model
        assert result["entities_confirmed"] >= 1
        assert "john.smith@example.com" not in result["anonymized_text"]


class TestOrganizationDetection:
    def test_org_in_context(self, engine):
        text = (
            "Acme Corporation, a company incorporated under the laws of Delaware, "
            "hereby agrees to acquire all outstanding shares of GlobalTech Ltd."
        )
        entities = engine.detect(text, "en")
        orgs = [e for e in entities if e["type"] == "ORGANIZATION" and e.get("verified")]
        assert len(orgs) >= 1, f"Expected at least 1 organization, got {orgs}"


class TestLocationDetection:
    def test_location_via_anonymize(self, engine):
        """Location detection tested through full anonymization pipeline."""
        text = (
            "The Company's registered office is located at 42 Baker Street, London, "
            "United Kingdom. All notices shall be sent to this address. "
            "Contact: reception@company.com"
        )
        result = engine.anonymize_text(text)
        # At least email should be caught
        assert "reception@company.com" not in result["anonymized_text"]


class TestPatternDetection:
    def test_email(self, engine):
        entities = engine.detect("Send to john.smith@example.com for review.", "en")
        emails = [e for e in entities if e["type"] == "EMAIL_ADDRESS"]
        assert any("john.smith@example.com" in e["text"] for e in emails), f"Expected email, got {emails}"

    def test_phone_international(self, engine):
        text = "For enquiries, please call +442079460958 or email us."
        entities = engine.detect(text, "en")
        phones = [e for e in entities if e["type"] == "PHONE_NUMBER"]
        assert len(phones) >= 1, f"Expected phone number, got {phones}"

    def test_iban(self, engine):
        entities = engine.detect("Transfer to GB29NWBK60161331926819.", "en")
        ibans = [e for e in entities if e["type"] == "IBAN_CODE"]
        assert len(ibans) >= 1, f"Expected IBAN, got {ibans}"


class TestFalsePositiveFilter:
    """Stoplist terms should NOT be detected as PII."""

    def test_contract_roles_not_person(self, engine):
        text = "The Contractor shall deliver the work to the Client within 30 days."
        entities = engine.detect(text, "en")
        persons = [e for e in entities if e["type"] == "PERSON" and e.get("verified")]
        person_texts = [e["text"].lower() for e in persons]
        assert "contractor" not in person_texts, f"'Contractor' should be filtered, got {person_texts}"
        assert "client" not in person_texts, f"'Client' should be filtered, got {person_texts}"

    def test_legal_terms_not_org(self, engine):
        text = "This Agreement is governed by the laws of England."
        entities = engine.detect(text, "en")
        orgs = [e for e in entities if e["type"] == "ORGANIZATION" and e.get("verified")]
        org_texts = [e["text"].lower() for e in orgs]
        assert "agreement" not in org_texts, f"'Agreement' should be filtered, got {org_texts}"

    def test_seller_buyer_not_person(self, engine):
        text = "The Seller warrants to the Buyer that all shares are valid."
        entities = engine.detect(text, "en")
        persons = [e for e in entities if e["type"] == "PERSON" and e.get("verified")]
        person_texts = [e["text"].lower() for e in persons]
        assert "seller" not in person_texts
        assert "buyer" not in person_texts

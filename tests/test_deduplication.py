"""Tests for entity deduplication — family-based placeholder assignment."""

import pytest
from collections import defaultdict


class TestFamilyDeduplication:
    def test_exact_reuse(self, engine, fresh_placeholders):
        """Same text gets same placeholder."""
        p = fresh_placeholders
        ph1 = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        ph2 = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        assert ph1 == ph2

    def test_family_variant(self, engine, fresh_placeholders):
        """Substring match creates variant: Acme → <ORG_1>, Acme Corp. → <ORG_1a>"""
        p = fresh_placeholders
        ph1 = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        ph2 = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        # Same family number, different suffix
        assert "ORG_1" in ph1
        assert "ORG_1a" in ph2

    def test_different_family(self, engine, fresh_placeholders):
        """Unrelated entities get different family numbers."""
        p = fresh_placeholders
        ph1 = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        ph2 = engine._get_or_create_placeholder(
            "ORGANIZATION", "GlobalTech Ltd.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        assert "ORG_1" in ph1
        assert "ORG_2" in ph2

    def test_cross_type_independence(self, engine, fresh_placeholders):
        """PERSON and ORG counters are independent."""
        p = fresh_placeholders
        ph_person = engine._get_or_create_placeholder(
            "PERSON", "John Smith",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        ph_org = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        assert "PERSON_1" in ph_person
        assert "ORG_1" in ph_org

    def test_prefix(self, engine, fresh_placeholders):
        """Prefix is prepended to placeholder."""
        p = fresh_placeholders
        ph = engine._get_or_create_placeholder(
            "PERSON", "John Smith",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], "D1"
        )
        assert ph == "<D1_PERSON_1>"

    def test_mapping_stores_exact_text(self, engine, fresh_placeholders):
        """Mapping stores the exact original text for each placeholder."""
        p = fresh_placeholders
        engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        assert p["mapping"]["<ORG_1>"] == "Acme"
        assert p["mapping"]["<ORG_1a>"] == "Acme Corp."

    def test_multiple_variants(self, engine, fresh_placeholders):
        """Multiple variants: a, b, c..."""
        p = fresh_placeholders
        engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        ph_a = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corp.",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        ph_b = engine._get_or_create_placeholder(
            "ORGANIZATION", "Acme Corporation",
            p["type_counters"], p["seen_exact"], p["seen_family"], p["mapping"], ""
        )
        assert "ORG_1a" in ph_a
        assert "ORG_1b" in ph_b

"""Fixed ontology: entity types, relations, and allowed (domain, relation, range) edges."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

MAX_CHOICE_OPTIONS = 26
MAX_TYPE_LIST = 50
MAX_RELATION_EDGES = 100
NOT_ENTITY = "NOT_ENTITY"
NO_RELATION = "NONE"


class EntityType(BaseModel):
    id: str
    description: str
    aliases: list[str] = Field(default_factory=list)
    color: str = "#64748b"

    @field_validator("id")
    @classmethod
    def upper_id(cls, v: str) -> str:
        out = v.strip().upper().replace(" ", "_")
        if not out or not out.replace("_", "").isalnum():
            raise ValueError(f"bad type id: {v!r}")
        return out


class RelationType(BaseModel):
    id: str
    description: str
    domain: list[str]
    range: list[str]
    symmetric: bool = False

    @field_validator("id")
    @classmethod
    def upper_id(cls, v: str) -> str:
        return v.strip().upper().replace(" ", "_")

    @field_validator("domain", "range")
    @classmethod
    def upper_lists(cls, v: list[str]) -> list[str]:
        return [x.strip().upper().replace(" ", "_") for x in v]


class Ontology(BaseModel):
    id: str
    version: int = 1
    title: str = ""
    types: list[EntityType]
    relations: list[RelationType]
    gazetteer: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_limits(self) -> Ontology:
        if not (2 <= len(self.types) <= MAX_TYPE_LIST):
            raise ValueError(
                f"An ontology needs between 2 and {MAX_TYPE_LIST} kinds of name. "
                f"This file lists {len(self.types)}. Add another type, or split a large list."
            )
        type_ids = [t.id for t in self.types]
        if len(set(type_ids)) != len(type_ids):
            dupes = sorted({i for i in type_ids if type_ids.count(i) > 1})
            raise ValueError(
                f"Two kinds share the same id ({', '.join(dupes)}). Give each type a unique id."
            )
        type_id_set = set(type_ids)
        rel_ids = [r.id for r in self.relations]
        if len(set(rel_ids)) != len(rel_ids):
            dupes_r = sorted({i for i in rel_ids if rel_ids.count(i) > 1})
            raise ValueError(
                f"Two links share the same id ({', '.join(dupes_r)}). Give each relation a unique id."
            )
        edges = 0
        for rel in self.relations:
            for d in rel.domain:
                if d not in type_id_set:
                    raise ValueError(
                        f"The link {rel.id} starts from {d}, but {d} is not listed under types. "
                        "Add that type, or fix the domain list."
                    )
            for r in rel.range:
                if r not in type_id_set:
                    raise ValueError(
                        f"The link {rel.id} points at {r}, but {r} is not listed under types. "
                        "Add that type, or fix the range list."
                    )
            edges += len(rel.domain) * len(rel.range)
        if edges > MAX_RELATION_EDGES:
            raise ValueError(
                f"This ontology allows {edges} kind-to-kind pairs, above the limit of "
                f"{MAX_RELATION_EDGES}. Narrow domain or range lists."
            )
        cleaned: dict[str, str] = {}
        for name, typ in self.gazetteer.items():
            key = name.strip()
            t = typ.strip().upper().replace(" ", "_")
            if t not in type_id_set:
                raise ValueError(
                    f"The listed name {key!r} is tagged {t}, which is not a type in this file. "
                    "Use one of the type ids, or add that type."
                )
            cleaned[key] = t
        self.gazetteer = cleaned
        return self

    def type_map(self) -> dict[str, EntityType]:
        return {t.id: t for t in self.types}

    def relation_map(self) -> dict[str, RelationType]:
        return {r.id: r for r in self.relations}

    def type_ids(self) -> list[str]:
        return [t.id for t in self.types]

    def relation_ids(self) -> list[str]:
        return [r.id for r in self.relations]

    def type_choice_criteria(self) -> dict[str, str]:
        criteria = {t.id: t.description for t in self.types}
        criteria[NOT_ENTITY] = "Not a named entity of this ontology, or a pronoun, or noise."
        if len(criteria) < 2:
            raise ValueError("choice needs at least 2 options")
        return criteria

    def needs_two_stage_typing(self) -> bool:
        return len(self.types) + 1 > MAX_CHOICE_OPTIONS

    def type_groups(self) -> list[list[EntityType]]:
        """Partition types so each Choice, plus NOT_ENTITY, stays within 26 options."""
        room = MAX_CHOICE_OPTIONS - 1
        groups: list[list[EntityType]] = []
        for i in range(0, len(self.types), room):
            groups.append(list(self.types[i : i + room]))
        return groups

    def group_choice_criteria(self) -> dict[str, str]:
        groups = self.type_groups()
        if len(groups) + 1 > MAX_CHOICE_OPTIONS:
            raise ValueError("too many type groups even after partitioning")
        criteria = {f"GROUP_{i}": ", ".join(t.id for t in g) for i, g in enumerate(groups)}
        criteria[NOT_ENTITY] = "Not a named entity of this ontology, or a pronoun, or noise."
        return criteria

    def relation_choice_criteria(self, src_type: str, tgt_type: str) -> dict[str, str]:
        allowed: dict[str, str] = {}
        for rel in self.relations:
            if src_type in rel.domain and tgt_type in rel.range:
                allowed[rel.id] = rel.description
            elif rel.symmetric and tgt_type in rel.domain and src_type in rel.range:
                allowed[rel.id] = rel.description
        allowed[NO_RELATION] = "No listed relation holds between these two mentions."
        if len(allowed) > MAX_CHOICE_OPTIONS:
            raise ValueError(
                f"The pair {src_type} → {tgt_type} has {len(allowed)} options, above the "
                f"limit of {MAX_CHOICE_OPTIONS} for one question. Split a relation."
            )
        return allowed

    def allowed_pairs(self, src_type: str, tgt_type: str) -> list[str]:
        keys = [k for k in self.relation_choice_criteria(src_type, tgt_type) if k != NO_RELATION]
        return keys

    def gazetteer_type(self, surface: str) -> str | None:
        """Exact name the ontology already lists. Not a guess about shape."""
        return self.gazetteer.get(surface.strip())

    def color_for(self, type_id: str) -> str:
        found = self.type_map().get(type_id)
        return found.color if found else "#94a3b8"


def load_ontology(path: str | Path) -> Ontology:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("ontology YAML must be a mapping")
    return ontology_from_dict(data)


def ontology_from_dict(data: dict[str, Any]) -> Ontology:
    types = []
    for item in data.get("types") or []:
        if isinstance(item, str):
            types.append(EntityType(id=item, description=item.replace("_", " ").title()))
        else:
            types.append(EntityType(**item))
    relations = [RelationType(**item) for item in (data.get("relations") or [])]
    return Ontology(
        id=data.get("id") or "unnamed",
        version=int(data.get("version") or 1),
        title=data.get("title") or "",
        types=types,
        relations=relations,
        gazetteer=data.get("gazetteer") or {},
    )


def bundled_ontology_names() -> list[str]:
    here = Path(__file__).resolve().parent / "data"
    names = sorted(p.stem for p in here.glob("*.yaml"))
    if names:
        return names
    extra = Path(__file__).resolve().parent.parent.parent / "data" / "ontology"
    return sorted(p.stem for p in extra.glob("*.yaml"))


def bundled_ontology_path(name: str = "tech_docs") -> Path:
    here = Path(__file__).resolve().parent
    packaged = here / "data" / f"{name}.yaml"
    if packaged.exists():
        return packaged
    return here.parent.parent / "data" / "ontology" / f"{name}.yaml"


def resolve_ontology_path(name_or_path: str | Path) -> Path:
    """A bundled name (tech_docs) or a YAML path."""
    raw = Path(name_or_path)
    if raw.exists():
        return raw
    token = str(name_or_path).strip()
    if "/" not in token and "\\" not in token and not token.endswith(".yaml"):
        found = bundled_ontology_path(token)
        if found.exists():
            return found
        known = ", ".join(bundled_ontology_names()) or "(none packaged)"
        raise FileNotFoundError(
            f"No bundled ontology named {token!r}. Shipped names: {known}. "
            "Pass a path to a YAML file instead."
        )
    raise FileNotFoundError(f"No ontology file at {raw}")


def load_ontology_named(name_or_path: str | Path) -> Ontology:
    return load_ontology(resolve_ontology_path(name_or_path))


STARTER_ONTOLOGY = """# Kinds of name and the legal links between them.
# Save this file and pass it with --ontology.

id: my_domain
version: 1
title: My domain
types:
  - id: PERSON
    description: A named person.
    color: "#7dd3fc"
  - id: ORGANIZATION
    description: A named company, team, or other group.
    color: "#c4b5fd"
  - id: LOCATION
    description: A named city, country, or place.
    color: "#fda4af"
relations:
  - id: WORKS_AT
    description: The person works at the organization.
    domain: [PERSON]
    range: [ORGANIZATION]
  - id: LOCATED_IN
    description: The organization or person is in this place.
    domain: [ORGANIZATION, PERSON]
    range: [LOCATION]
gazetteer:
  # Optional. Exact names you already know, mapped to a type.
  # Jane Doe: PERSON
"""


def write_starter_ontology(path: str | Path) -> Path:
    out = Path(path)
    if out.exists():
        raise FileExistsError(f"{out} already exists. Pick another path.")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(STARTER_ONTOLOGY, encoding="utf-8")
    return out


def describe_ontology(ontology: Ontology) -> dict[str, object]:
    pairs: list[str] = []
    for src in ontology.type_ids():
        for tgt in ontology.type_ids():
            for rel in ontology.allowed_pairs(src, tgt):
                pairs.append(f"{src} -[{rel}]-> {tgt}")
    return {
        "id": ontology.id,
        "title": ontology.title or ontology.id,
        "types": [{"id": t.id, "description": t.description} for t in ontology.types],
        "relations": [
            {
                "id": r.id,
                "description": r.description,
                "domain": r.domain,
                "range": r.range,
            }
            for r in ontology.relations
        ],
        "legal_pairs": pairs,
        "listed_names": len(ontology.gazetteer),
    }

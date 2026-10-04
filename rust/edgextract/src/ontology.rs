//! Fixed ontology: entity types, relations, and allowed (domain, relation, range) edges.

use crate::error::Error;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_CHOICE_OPTIONS: usize = 26;
pub const MAX_TYPE_LIST: usize = 50;
pub const MAX_RELATION_EDGES: usize = 100;
pub const NOT_ENTITY: &str = "NOT_ENTITY";
pub const NO_RELATION: &str = "NONE";

const TECH_DOCS_YAML: &str = include_str!("../../../data/ontology/tech_docs.yaml");
const COMPANY_NEWS_YAML: &str = include_str!("../../../data/ontology/company_news.yaml");
const CONLL04_YAML: &str = include_str!("../../../data/ontology/conll04.yaml");

pub const STARTER_ONTOLOGY: &str = r###"# Kinds of name and the legal links between them.
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
"###;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntityType {
    pub id: String,
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_color")]
    pub color: String,
}

fn default_color() -> String {
    "#64748b".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RelationType {
    pub id: String,
    pub description: String,
    pub domain: Vec<String>,
    pub range: Vec<String>,
    #[serde(default)]
    pub symmetric: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ontology {
    pub id: String,
    #[serde(default = "one")]
    pub version: i64,
    #[serde(default)]
    pub title: String,
    pub types: Vec<EntityType>,
    pub relations: Vec<RelationType>,
    #[serde(default)]
    pub gazetteer: IndexMap<String, String>,
}

fn one() -> i64 {
    1
}

fn upper_id(v: &str) -> String {
    v.trim().to_uppercase().replace(' ', "_")
}

fn is_alnum_id(s: &str) -> bool {
    let stripped: String = s.chars().filter(|c| *c != '_').collect();
    !stripped.is_empty() && stripped.chars().all(|c| c.is_ascii_alphanumeric())
}

impl Ontology {
    pub fn validate(mut self) -> Result<Self, Error> {
        if !(2..=MAX_TYPE_LIST).contains(&self.types.len()) {
            return Err(Error::Ontology(format!(
                "An ontology needs between 2 and {MAX_TYPE_LIST} kinds of name. \
                 This file lists {}. Add another type, or split a large list.",
                self.types.len()
            )));
        }
        for t in &mut self.types {
            t.id = upper_id(&t.id);
            if !is_alnum_id(&t.id) {
                return Err(Error::Ontology(format!("bad type id: {}", t.id)));
            }
        }
        let type_ids: Vec<String> = self.types.iter().map(|t| t.id.clone()).collect();
        let mut seen: HashSet<String> = HashSet::new();
        let mut dupes = Vec::new();
        for id in &type_ids {
            if !seen.insert(id.clone()) {
                dupes.push(id.clone());
            }
        }
        dupes.sort();
        dupes.dedup();
        if !dupes.is_empty() {
            return Err(Error::Ontology(format!(
                "Two kinds share the same id ({}). Give each type a unique id.",
                dupes.join(", ")
            )));
        }
        let type_id_set: HashSet<String> = type_ids.into_iter().collect();
        for r in &mut self.relations {
            r.id = upper_id(&r.id);
            r.domain = r.domain.iter().map(|x| upper_id(x)).collect();
            r.range = r.range.iter().map(|x| upper_id(x)).collect();
        }
        let rel_ids: Vec<String> = self.relations.iter().map(|r| r.id.clone()).collect();
        seen.clear();
        let mut dupes_r = Vec::new();
        for id in &rel_ids {
            if !seen.insert(id.clone()) {
                dupes_r.push(id.clone());
            }
        }
        dupes_r.sort();
        dupes_r.dedup();
        if !dupes_r.is_empty() {
            return Err(Error::Ontology(format!(
                "Two links share the same id ({}). Give each relation a unique id.",
                dupes_r.join(", ")
            )));
        }
        let mut edges = 0usize;
        for rel in &self.relations {
            for d in &rel.domain {
                if !type_id_set.contains(d) {
                    return Err(Error::Ontology(format!(
                        "The link {} starts from {d}, but {d} is not listed under types. \
                         Add that type, or fix the domain list.",
                        rel.id
                    )));
                }
            }
            for r in &rel.range {
                if !type_id_set.contains(r) {
                    return Err(Error::Ontology(format!(
                        "The link {} points at {r}, but {r} is not listed under types. \
                         Add that type, or fix the range list.",
                        rel.id
                    )));
                }
            }
            edges += rel.domain.len() * rel.range.len();
        }
        if edges > MAX_RELATION_EDGES {
            return Err(Error::Ontology(format!(
                "This ontology allows {edges} kind-to-kind pairs, above the limit of \
                 {MAX_RELATION_EDGES}. Narrow domain or range lists."
            )));
        }
        let mut cleaned = IndexMap::new();
        for (name, typ) in &self.gazetteer {
            let key = name.trim().to_string();
            let t = upper_id(typ);
            if !type_id_set.contains(&t) {
                return Err(Error::Ontology(format!(
                    "The listed name {key:?} is tagged {t}, which is not a type in this file. \
                     Use one of the type ids, or add that type."
                )));
            }
            cleaned.insert(key, t);
        }
        self.gazetteer = cleaned;
        Ok(self)
    }

    pub fn type_map(&self) -> HashMap<String, EntityType> {
        self.types.iter().map(|t| (t.id.clone(), t.clone())).collect()
    }

    pub fn type_ids(&self) -> Vec<String> {
        self.types.iter().map(|t| t.id.clone()).collect()
    }

    pub fn type_choice_criteria(&self) -> Result<IndexMap<String, String>, Error> {
        let mut criteria = IndexMap::new();
        for t in &self.types {
            criteria.insert(t.id.clone(), t.description.clone());
        }
        criteria.insert(
            NOT_ENTITY.into(),
            "Not a named entity of this ontology, or a pronoun, or noise.".into(),
        );
        if criteria.len() < 2 {
            return Err(Error::Ontology("choice needs at least 2 options".into()));
        }
        Ok(criteria)
    }

    pub fn needs_two_stage_typing(&self) -> bool {
        self.types.len() + 1 > MAX_CHOICE_OPTIONS
    }

    pub fn type_groups(&self) -> Vec<Vec<EntityType>> {
        let room = MAX_CHOICE_OPTIONS - 1;
        self.types.chunks(room).map(|c| c.to_vec()).collect()
    }

    pub fn group_choice_criteria(&self) -> Result<IndexMap<String, String>, Error> {
        let groups = self.type_groups();
        if groups.len() + 1 > MAX_CHOICE_OPTIONS {
            return Err(Error::Ontology(
                "too many type groups even after partitioning".into(),
            ));
        }
        let mut criteria = IndexMap::new();
        for (i, g) in groups.iter().enumerate() {
            let ids: Vec<&str> = g.iter().map(|t| t.id.as_str()).collect();
            criteria.insert(format!("GROUP_{i}"), ids.join(", "));
        }
        criteria.insert(
            NOT_ENTITY.into(),
            "Not a named entity of this ontology, or a pronoun, or noise.".into(),
        );
        Ok(criteria)
    }

    pub fn relation_choice_criteria(
        &self,
        src_type: &str,
        tgt_type: &str,
    ) -> Result<IndexMap<String, String>, Error> {
        let mut allowed = IndexMap::new();
        for rel in &self.relations {
            if rel.domain.iter().any(|d| d == src_type) && rel.range.iter().any(|r| r == tgt_type) {
                allowed.insert(rel.id.clone(), rel.description.clone());
            } else if rel.symmetric
                && rel.domain.iter().any(|d| d == tgt_type)
                && rel.range.iter().any(|r| r == src_type)
            {
                allowed.insert(rel.id.clone(), rel.description.clone());
            }
        }
        allowed.insert(
            NO_RELATION.into(),
            "No listed relation holds between these two mentions.".into(),
        );
        if allowed.len() > MAX_CHOICE_OPTIONS {
            return Err(Error::Ontology(format!(
                "The pair {src_type} → {tgt_type} has {} options, above the \
                 limit of {MAX_CHOICE_OPTIONS} for one question. Split a relation.",
                allowed.len()
            )));
        }
        Ok(allowed)
    }

    pub fn allowed_pairs(&self, src_type: &str, tgt_type: &str) -> Result<Vec<String>, Error> {
        Ok(self
            .relation_choice_criteria(src_type, tgt_type)?
            .into_iter()
            .filter(|(k, _)| k != NO_RELATION)
            .map(|(k, _)| k)
            .collect())
    }

    /// Exact listed spelling. "markdown" is not the listed name "Markdown".
    pub fn gazetteer_type(&self, surface: &str) -> Option<&str> {
        self.gazetteer.get(surface.trim()).map(|s| s.as_str())
    }

    pub fn color_for(&self, type_id: &str) -> String {
        self.type_map()
            .get(type_id)
            .map(|t| t.color.clone())
            .unwrap_or_else(|| "#94a3b8".into())
    }
}

pub fn ontology_from_value(data: &Value) -> Result<Ontology, Error> {
    let obj = data
        .as_object()
        .ok_or_else(|| Error::Ontology("ontology YAML must be a mapping".into()))?;
    let mut types = Vec::new();
    for item in obj.get("types").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        if let Some(s) = item.as_str() {
            types.push(EntityType {
                id: s.to_string(),
                description: s.replace('_', " ").to_string(),
                aliases: vec![],
                color: default_color(),
            });
        } else {
            let mut t: EntityType = serde_json::from_value(item)
                .map_err(|e| Error::Ontology(e.to_string()))?;
            if t.description.is_empty() {
                t.description = t.id.clone();
            }
            types.push(t);
        }
    }
    let relations: Vec<RelationType> = match obj.get("relations") {
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| Error::Ontology(e.to_string()))?,
        None => vec![],
    };
    let gazetteer: IndexMap<String, String> = match obj.get("gazetteer") {
        Some(v) if !v.is_null() => {
            serde_json::from_value(v.clone()).map_err(|e| Error::Ontology(e.to_string()))?
        }
        _ => IndexMap::new(),
    };
    let ont = Ontology {
        id: obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unnamed")
            .to_string(),
        version: obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1),
        title: obj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        types,
        relations,
        gazetteer,
    };
    ont.validate()
}

pub fn ontology_from_yaml(text: &str) -> Result<Ontology, Error> {
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(text).map_err(|e| Error::Ontology(e.to_string()))?;
    let json = serde_json::to_value(yaml).map_err(|e| Error::Ontology(e.to_string()))?;
    ontology_from_value(&json)
}

pub fn load_ontology(path: impl AsRef<Path>) -> Result<Ontology, Error> {
    let text = fs::read_to_string(path)?;
    ontology_from_yaml(&text)
}

pub fn bundled_yaml(name: &str) -> Option<&'static str> {
    match name {
        "tech_docs" => Some(TECH_DOCS_YAML),
        "company_news" => Some(COMPANY_NEWS_YAML),
        "conll04" => Some(CONLL04_YAML),
        _ => None,
    }
}

pub fn bundled_ontology_names() -> Vec<&'static str> {
    vec!["company_news", "conll04", "tech_docs"]
}

pub fn data_ontology_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/ontology")
}

pub fn resolve_ontology_path(name_or_path: &str) -> Result<PathBuf, Error> {
    let raw = PathBuf::from(name_or_path);
    if raw.exists() {
        return Ok(raw);
    }
    let token = name_or_path.trim();
    if !token.contains('/') && !token.contains('\\') && !token.ends_with(".yaml") {
        let found = data_ontology_dir().join(format!("{token}.yaml"));
        if found.exists() {
            return Ok(found);
        }
        if bundled_yaml(token).is_some() {
            return Ok(found);
        }
        let known = bundled_ontology_names().join(", ");
        return Err(Error::Io(format!(
            "No bundled ontology named {token:?}. Shipped names: {known}. \
             Pass a path to a YAML file instead."
        )));
    }
    Err(Error::Io(format!("No ontology file at {}", raw.display())))
}

pub fn load_ontology_named(name_or_path: &str) -> Result<Ontology, Error> {
    let token = name_or_path.trim();
    if let Some(yaml) = bundled_yaml(token) {
        if !Path::new(token).exists() && !token.ends_with(".yaml") && !token.contains('/') {
            return ontology_from_yaml(yaml);
        }
    }
    let path = resolve_ontology_path(name_or_path)?;
    if path.exists() {
        load_ontology(&path)
    } else if let Some(yaml) = bundled_yaml(token) {
        ontology_from_yaml(yaml)
    } else {
        Err(Error::Io(format!("No ontology file at {}", path.display())))
    }
}

pub fn write_starter_ontology(path: impl AsRef<Path>) -> Result<PathBuf, Error> {
    let out = path.as_ref();
    if out.exists() {
        return Err(Error::Io(format!(
            "{} already exists. Pick another path.",
            out.display()
        )));
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(out, STARTER_ONTOLOGY)?;
    Ok(out.to_path_buf())
}

pub fn describe_ontology(ontology: &Ontology) -> Value {
    let mut pairs = Vec::new();
    for src in ontology.type_ids() {
        for tgt in ontology.type_ids() {
            if let Ok(rels) = ontology.allowed_pairs(&src, &tgt) {
                for rel in rels {
                    pairs.push(format!("{src} -[{rel}]-> {tgt}"));
                }
            }
        }
    }
    serde_json::json!({
        "id": ontology.id,
        "title": if ontology.title.is_empty() { ontology.id.clone() } else { ontology.title.clone() },
        "types": ontology.types.iter().map(|t| serde_json::json!({"id": t.id, "description": t.description, "color": t.color})).collect::<Vec<_>>(),
        "relations": ontology.relations.iter().map(|r| serde_json::json!({
            "id": r.id,
            "description": r.description,
            "domain": r.domain,
            "range": r.range,
        })).collect::<Vec<_>>(),
        "legal_pairs": pairs,
        "listed_names": ontology.gazetteer.len(),
        "gazetteer": ontology.gazetteer.keys().collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tech_docs_loads() {
        let ont = load_ontology_named("tech_docs").unwrap();
        assert_eq!(ont.id, "tech_docs");
        assert!(ont.types.len() >= 2);
        let crit = ont.type_choice_criteria().unwrap();
        assert!(crit.contains_key(NOT_ENTITY));
        assert!(crit.len() <= MAX_CHOICE_OPTIONS);
        let allowed = ont.allowed_pairs("PERSON", "ORGANIZATION").unwrap();
        assert!(allowed.iter().any(|x| x == "WORKS_AT"));
        assert!(ont.allowed_pairs("LOCATION", "PERSON").unwrap().is_empty());
        assert_eq!(ont.gazetteer_type("Acme Inc"), Some("ORGANIZATION"));
        assert_eq!(ont.gazetteer_type("acme inc"), None);
    }

    #[test]
    fn company_news_loads_and_has_pairs() {
        let ont = load_ontology_named("company_news").unwrap();
        assert_eq!(ont.id, "company_news");
        let founded = ont.allowed_pairs("PERSON", "COMPANY").unwrap();
        assert!(founded.iter().any(|x| x == "FOUNDED"));
        let acquired = ont.allowed_pairs("COMPANY", "COMPANY").unwrap();
        assert!(acquired.iter().any(|x| x == "ACQUIRED"));
        assert!(ont.allowed_pairs("LOCATION", "PERSON").unwrap().is_empty());
    }

    #[test]
    fn rejects_unknown_domain() {
        let data = serde_json::json!({
            "id": "bad",
            "types": [{"id": "A", "description": "a"}, {"id": "B", "description": "b"}],
            "relations": [{"id": "X", "description": "x", "domain": ["Z"], "range": ["B"]}],
        });
        let err = ontology_from_value(&data).unwrap_err().to_string();
        assert!(err.contains("starts from Z"));
    }

    #[test]
    fn rejects_too_few_types() {
        let ont = Ontology {
            id: "x".into(),
            version: 1,
            title: String::new(),
            types: vec![EntityType {
                id: "A".into(),
                description: "a".into(),
                aliases: vec![],
                color: default_color(),
            }],
            relations: vec![],
            gazetteer: IndexMap::new(),
        };
        assert!(ont.validate().is_err());
    }

    #[test]
    fn two_stage_typing_does_not_raise() {
        let types: Vec<Value> = (0..30)
            .map(|i| serde_json::json!({"id": format!("T{i:02}"), "description": format!("type {i}")}))
            .collect();
        let ont = ontology_from_value(&serde_json::json!({
            "id": "wide",
            "types": types,
            "relations": [{"id": "REL", "description": "r", "domain": ["T00"], "range": ["T01"]}],
        }))
        .unwrap();
        assert!(ont.needs_two_stage_typing());
        let groups = ont.group_choice_criteria().unwrap();
        assert!(groups.contains_key(NOT_ENTITY));
        assert!(groups.len() <= 26);
    }
}

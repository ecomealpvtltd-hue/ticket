-- Who set the category, and where the suggestion came from.
-- category_source: customer | rules | ai | agent
-- triage_source:   rules | ai
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category_source text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS triage_source text;
UPDATE tickets SET category_source = 'customer' WHERE category IS NOT NULL AND category_source IS NULL;

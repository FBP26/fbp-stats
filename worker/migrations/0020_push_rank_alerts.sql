ALTER TABLE push_devices ADD COLUMN top_five INTEGER NOT NULL DEFAULT 0 CHECK (top_five IN (0, 1));
ALTER TABLE push_devices ADD COLUMN top_ten INTEGER NOT NULL DEFAULT 0 CHECK (top_ten IN (0, 1));
ALTER TABLE push_devices ADD COLUMN lead_change INTEGER NOT NULL DEFAULT 0 CHECK (lead_change IN (0, 1));
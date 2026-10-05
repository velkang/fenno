-- The position a run works on. The agent proposes a change to one position; when the user
-- approves, the run starts on that position. Older rows have none.
ALTER TABLE automation_runs ADD COLUMN token_id TEXT;

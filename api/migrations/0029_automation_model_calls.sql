-- Model calls the agent made each UTC day, across all users, so a daily limit caps the bill.
-- One small row per day.
CREATE TABLE automation_model_calls (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);

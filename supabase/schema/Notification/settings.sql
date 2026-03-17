CREATE TABLE notifications.settings (
  key text NOT NULL,
  value text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (key)
);

CREATE TABLE public.keys (
  key_name text NOT NULL,
  key_value text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT keys_pkey PRIMARY KEY (key_name),
  CONSTRAINT keys_key_name_check CHECK ((key_name = ANY (ARRAY['admin'::text, 'staff'::text, 'viewer'::text]))),
  CONSTRAINT keys_key_value_length_check CHECK ((char_length(key_value) = 32)),
  CONSTRAINT keys_key_value_base64_check CHECK ((key_value ~ '^[A-Za-z0-9+/]{32}$'::text)),
  CONSTRAINT keys_key_value_key UNIQUE (key_value)
);

ALTER TABLE public.keys ENABLE ROW LEVEL SECURITY;

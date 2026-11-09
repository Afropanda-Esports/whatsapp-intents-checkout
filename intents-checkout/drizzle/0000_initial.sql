CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  api_key_hash text NOT NULL,
  webhook_url text NOT NULL,
  webhook_secret text NOT NULL
);
--> statement-breakpoint
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  merchant_order_id text NOT NULL CHECK (char_length(merchant_order_id) <= 64),
  status text NOT NULL,
  origin_asset text NOT NULL,
  destination_asset text NOT NULL,
  amount_out numeric(78, 0) NOT NULL,
  amount_in numeric(78, 0) NOT NULL,
  min_amount_in numeric(78, 0) NOT NULL,
  deposit_address text NOT NULL,
  deposit_memo text,
  refund_to text NOT NULL,
  confidential boolean NOT NULL DEFAULT false,
  deadline timestamptz NOT NULL,
  deposited_amount numeric(78, 0),
  settled_amount numeric(78, 0),
  refunded_amount numeric(78, 0) NOT NULL DEFAULT 0,
  fulfilled_at timestamptz,
  one_click_status text,
  quote jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, merchant_order_id),
  UNIQUE (deposit_address)
);
--> statement-breakpoint
CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments (id),
  from_status text,
  to_status text NOT NULL,
  one_click_status text,
  detail jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payment_id uuid REFERENCES payments (id),
  payee text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  reason text,
  status text NOT NULL,
  policy_request_id text,
  policy_tx_hashes jsonb,
  one_click_deposit_address text,
  quote jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  delivered_at timestamptz
);

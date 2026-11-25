CREATE TABLE IF NOT EXISTS inventory (
    item_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    stock INT NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(50) PRIMARY KEY,
    item_id VARCHAR(50) NOT NULL REFERENCES inventory(item_id),
    quantity INT NOT NULL CHECK (quantity > 0),
    amount NUMERIC(10, 2) NOT NULL,
    webhook_url TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

INSERT INTO inventory (item_id, name, stock) VALUES
    ('kb-mech-01', 'Mechanical Keyboard', 50),
    ('mouse-pro-02', 'Wireless Ergonomic Mouse', 100)
ON CONFLICT (item_id) DO NOTHING;
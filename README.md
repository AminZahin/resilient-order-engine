# Resilient Order & Webhook Processing Engine

> **Live Interactive Architecture Simulator (Before vs. After):**  
> **[Launch Live Demo → resilient-order-engine]([https://USERNAME_AWAK.github.io/resilient-order-engine/](https://aminzahin.github.io/resilient-order-engine/))**  
> *Toggle between a naive synchronous implementation and this resilient engine to see how it handles duplicate payment retries, third-party webhook outages, and 500k-row CSV exports.*

---

## Why I Built This Project

Modern AI tools can scaffold basic CRUD endpoints in seconds—but production backend engineering is defined by what happens **when things go wrong**: network timeouts, duplicate client retries, traffic spikes, and memory-intensive exports.

I built this project to demonstrate the core Node.js and distributed-systems engineering fundamentals required to keep real-world services reliable under load:

* **Strict Runtime Validation (`Zod`):** Enforces type safety across external boundaries (`req.body`, headers, environment variables).
* **Idempotency Keys (`Redis`):** Intercepts duplicate network retries so customers are never double-charged.
* **Atomic Transactions (`PostgreSQL`):** Deducts inventory and commits orders inside a single ACID transaction to prevent race conditions.
* **Async Background Workers (`BullMQ`):** Decouples slow outbound webhooks from the HTTP request lifecycle, keeping API latency under 20ms.
* **Fault-Tolerant Delivery (`Exponential Backoff + DLQ`):** Automatically retries failed partner webhooks and routes persistently failing events to a Dead-Letter Queue for safe replay.
* **Memory-Safe Reporting (`Node.js Streams`):** Pipes PostgreSQL cursors directly to HTTP responses, keeping RAM usage flat (~40MB) even when exporting 500,000+ rows.
* **Zero-Downtime Shutdown (`SIGTERM / SIGINT`):** Drains active HTTP connections and finishes in-flight worker jobs before process exit.

---

## Architecture Comparison: Naive vs. Resilient

| Real-World Scenario | ❌ Typical AI / Junior App | ✅ This Production Engine |
| :--- | :--- | :--- |
| **User clicks "Pay" twice on bad Wi-Fi** | User gets charged twice; duplicate orders created. | **Redis Idempotency Key** blocks the retry and returns the cached response. |
| **API Response Time** | 3–10 seconds (blocks while waiting for partner webhooks). | **< 20ms (`202 Accepted`)**; slow work is offloaded to **BullMQ**. |
| **Partner Webhook Server Goes Down** | HTTP request fails (`500`) and webhook payload is lost. | **Exponential backoff retries** (2s → 4s → 8s) + **Dead-Letter Queue (DLQ)**. |
| **Exporting 500,000 Orders to CSV** | Loads all rows into an array → **Out-Of-Memory (OOM) Crash**. | **Node.js Readable Streams** maintain flat ~40MB memory usage. |
| **Deploying New Code** | Active database writes are cut off mid-flight. | **Graceful Shutdown (`SIGTERM`)** completes active jobs before exiting. |

---

## Request Lifecycle (How It Works)

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant API as Express API (Gatekeeper)
    participant Redis as Redis (Idempotency & Queue)
    participant DB as PostgreSQL (ACID)
    participant Worker as BullMQ Worker
    participant Partner as Partner Webhook

    Client->>API: POST /orders (Header: Idempotency-Key)
    API->>Redis: Check if Idempotency-Key exists
    alt Key Already Processed
        Redis-->>API: Return cached order payload
        API-->>Client: 200 OK (Duplicate prevented)
    else New Request
        API->>DB: BEGIN Transaction (Check & Deduct Stock + Insert Order)
        DB-->>API: COMMIT
        API->>Redis: Cache response (24h TTL) & Enqueue Webhook Job
        API-->>Client: 202 Accepted (< 20ms)
    end

    Worker->>Redis: Consume Webhook Job
    Worker->>Partner: POST Webhook (Signed with HMAC-SHA256)
    alt Partner Returns 500 / Timeout
        Partner--xWorker: Delivery Failed
        Note over Worker,Redis: Retry with Exponential Backoff (2s -> 4s -> 8s) -> Move to DLQ
    else Partner Returns 200 OK
        Partner-->>Worker: Acknowledged
    end
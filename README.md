# Governed Results-as-a-Service (GRaaS) MVP

A minimal platform for RaaS creators to register a **Result Contract**, submit an execution, verify it against the contract, issue a **Result Certificate**, and create a billable meter event.

## Architecture

`RaaS Creator → Result Contract → Execution Evidence → Verification → Result Certificate → Metering`

O-Lang is intended to sit at the governed execution boundary in the next integration step. This MVP deliberately keeps the result-certification layer independent from any specific model.

## Run

Requires Node.js 20+.

```bash
npm start
```

Server: `http://localhost:8787`

## API

- `GET /health`
- `POST /providers`
- `POST /contracts`
- `POST /executions`
- `POST /executions/:id/certify`
- `GET /certificates/:id`
- `GET /meter/:providerId`

## Example flow

1. Register a provider.
2. Create a Result Contract with permitted actions, verification conditions, evidence requirements and billing unit price.
3. Submit an execution containing actions and evidence.
4. Certify the execution.
5. If verified, a certificate is created and a billable meter event is recorded.

## Important MVP boundary

A certificate means: **the submitted execution satisfied the declared verification contract**. It does not claim that an AI answer is universally correct, nor does it constitute regulatory certification.

## Next implementation layer

1. Replace in-memory store with PostgreSQL.
2. Integrate the O-Lang runtime as the execution authority.
3. Add signed Result Contracts and provider/client identities.
4. Add chained cryptographic audit events and verification endpoints.
5. Add delegation/authority attenuation and max-depth enforcement.
6. Add idempotency and replay.
7. Add billing-provider adapters.
8. Add a creator dashboard and client verification portal.

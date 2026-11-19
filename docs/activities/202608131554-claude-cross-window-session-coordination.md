# Claude cross-window session coordination

Status: **Completed**
Date: 2026-08-13

## Activity

Recovered Claude session `99beeafb-07a1-452f-8074-14355fb95739` after two
code-server Extension Hosts resumed it concurrently, then added a host-wide
coordination boundary so the same failure cannot silently recur.

## Diagnosis

- two persistent Claude processes had the same `--resume` id and different
  Extension Host parents;
- both wrote to the same native JSONL transcript while separate browser
  windows projected independent in-memory state;
- the persisted AHP state was idle and its last turn was complete, while both
  stale Claude processes remained attached;
- the user's later send never reached the Symposium host, which explained the
  unresponsive surface without a corresponding backend failure.

## Delivered

- atomic, per-session cross-process leases shared by all code-server Extension
  Hosts on the machine;
- stale-owner recovery when an Extension Host dies without releasing its lease;
- generation tracking to detect turns written by another window;
- automatic Claude child refresh with `--resume` before a stale window writes;
- a retryable user-facing error when another window still owns an active turn;
- unit and integration coverage for overlap blocking, sequential handoff,
  stale-owner recovery and context refresh.

## Recovery

The two idle Claude processes were stopped by explicit PID after confirming no
active turn or queued message. The transcript was preserved; Claude only added
its normal `last-prompt` shutdown metadata.

## Outcome

Multiple computers may open the same code-server workspace, but only one
Extension Host can write a given Claude session at a time. Sequential use stays
supported, and each window resumes from the latest native transcript instead of
continuing with stale in-memory context.

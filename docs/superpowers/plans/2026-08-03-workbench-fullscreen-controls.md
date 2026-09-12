# Workbench Fullscreen Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the PR31 Workbench visible during fullscreen transitions and make its exit and palette controls reliably reachable.

**Architecture:** Extend the native fullscreen adapter with the bounded presentation operations already used by the app lifecycle. Keep Workbench interaction and styling changes local to the Workbench page and stylesheet.

**Tech Stack:** React, TypeScript, Zustand, Tauri v2, Vitest, CSS

## Global Constraints

- Do not redesign the Workbench.
- Do not change unrelated UI, themes, persistence, backend, or security behavior.
- Preserve native fullscreen as the source of truth.

## Task 1: Preserve native window presentation

- [x] Add a failing adapter test proving fullscreen writes restore visible, unminimized, focused presentation.
- [x] Extend the bounded native window interface and loader.
- [x] Restore presentation after each native fullscreen transition.
- [x] Run the focused native fullscreen tests.

## Task 2: Correct fullscreen controls

- [x] Add failing Workbench contract assertions for the 72-pixel reveal threshold and non-overlapping exit placement.
- [x] Move the exit control beside the upper Add pane action area.
- [x] Expand the left reveal zone without changing the palette itself.
- [x] Run the focused Workbench and fullscreen tests plus diff validation.

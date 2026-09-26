import { randomUUID } from "node:crypto";

export type SessionId = string & { readonly __brand: "SessionId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type AttemptId = string & { readonly __brand: "AttemptId" };
export type EventId = string & { readonly __brand: "EventId" };
export type ToolCallId = string & { readonly __brand: "ToolCallId" };

export const newSessionId = (): SessionId => `ses_${randomUUID()}` as SessionId;
export const newTurnId = (): TurnId => `trn_${randomUUID()}` as TurnId;
export const newAttemptId = (): AttemptId => `att_${randomUUID()}` as AttemptId;
export const newEventId = (): EventId => `evt_${randomUUID()}` as EventId;
export const newToolCallId = (): ToolCallId => `tc_${randomUUID()}` as ToolCallId;

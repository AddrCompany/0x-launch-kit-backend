import { SignedOrder } from '@0x/types';

export enum OrderWatcherLifeCycleEvents {
    Add,
    Remove,
}
export type OrderWatcherLifeCycleCallback = (
    lifeCycleEvent: OrderWatcherLifeCycleEvents,
    orders: SignedOrder[],
) => void;

export interface AdaptedOrderAndValidationResult {
    order: SignedOrder;
    message: string | undefined;
}

export interface AdaptedValidationResults {
    accepted: AdaptedOrderAndValidationResult[];
    rejected: AdaptedOrderAndValidationResult[];
}

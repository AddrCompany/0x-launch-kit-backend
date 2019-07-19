import { ContractWrappers, orderHashUtils } from '0x.js';
import { OrderState, OrderWatcher, SignedOrder } from '@0x/order-watcher';
import { intervalUtils } from '@0x/utils';
import { Provider } from 'ethereum-types';

import { DEFAULT_TAKER_SIMULATION_ADDRESS, ORDER_SHADOWING_MARGIN_MS, PERMANENT_CLEANUP_INTERVAL_MS } from '../config';
import {
    AdaptedOrderAndValidationResult,
    AdaptedValidationResults,
    OrderWatcherLifeCycleCallback,
    OrderWatcherLifeCycleEvents,
} from '../types';
import { utils } from '../utils';

export class OrderWatcherAdapter {
    private readonly _orderWatcher: OrderWatcher;
    private readonly _contractWrappers: ContractWrappers;
    private readonly _shadowedOrderHashes: Map<string, number>;
    private readonly _orders: Map<string, SignedOrder>;
    private readonly _lifeCycleEventCallback: OrderWatcherLifeCycleCallback;
    constructor(
        provider: Provider,
        networkId: number,
        lifeCycleEventCallback: OrderWatcherLifeCycleCallback,
        contractWrappers: ContractWrappers,
    ) {
        this._shadowedOrderHashes = new Map();
        this._orders = new Map();
        this._lifeCycleEventCallback = lifeCycleEventCallback;
        this._orderWatcher = new OrderWatcher(provider, networkId);
        this._orderWatcher.subscribe((err, orderState) => {
            if (err) {
                utils.log(err);
            } else {
                const state = orderState as OrderState;
                if (!state.isValid) {
                    this._shadowedOrderHashes.set(state.orderHash, Date.now());
                } else {
                    this._shadowedOrderHashes.delete(state.orderHash);
                }
            }
        });
        intervalUtils.setAsyncExcludingInterval(
            async () => {
                const permanentlyExpiredOrders: string[] = [];
                for (const [orderHash, shadowedAt] of this._shadowedOrderHashes) {
                    const now = Date.now();
                    if (shadowedAt + ORDER_SHADOWING_MARGIN_MS < now) {
                        permanentlyExpiredOrders.push(orderHash);
                    }
                }
                if (permanentlyExpiredOrders.length !== 0) {
                    for (const orderHash of permanentlyExpiredOrders) {
                        const order = this._orders.get(orderHash);
                        if (order) {
                            lifeCycleEventCallback(OrderWatcherLifeCycleEvents.Remove, [order]);
                            this._shadowedOrderHashes.delete(orderHash); // we need to remove this order so we don't keep shadowing it
                            this._orders.delete(orderHash);
                            this._orderWatcher.removeOrder(orderHash); // also remove from order watcher to avoid more callbacks
                        }
                    }
                }
            },
            PERMANENT_CLEANUP_INTERVAL_MS,
            utils.log,
        );
        this._contractWrappers = contractWrappers;
    }

    public async addOrdersAsync(orders: SignedOrder[]): Promise<AdaptedValidationResults> {
        const accepted: AdaptedOrderAndValidationResult[] = [];
        const rejected: AdaptedOrderAndValidationResult[] = [];
        for (const order of orders) {
            try {
                await this._contractWrappers.exchange.validateOrderFillableOrThrowAsync(order, {
                    simulationTakerAddress: DEFAULT_TAKER_SIMULATION_ADDRESS,
                });
                await this._orderWatcher.addOrderAsync(order);
                accepted.push({ order, message: undefined });
                const orderHash = orderHashUtils.getOrderHashHex(order);
                this._orders.set(orderHash, order);
                this._lifeCycleEventCallback(OrderWatcherLifeCycleEvents.Add, [order]);
            } catch (err) {
                rejected.push({ order, message: err.message });
            }
        }
        return {
            accepted,
            rejected,
        };
    }
    public removeOrders(orders: SignedOrder[]): void {
        for (const order of orders) {
            const orderHash = orderHashUtils.getOrderHashHex(order);
            this._orderWatcher.removeOrder(orderHash);
            this._orders.delete(orderHash);
        }
    }
    public orderFilter(order: SignedOrder): boolean {
        const orderHash = orderHashUtils.getOrderHashHex(order);
        return this._shadowedOrderHashes.has(orderHash);
    }
}

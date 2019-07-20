'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const _0x_js_1 = require('0x.js');
const order_watcher_1 = require('@0x/order-watcher');
const utils_1 = require('@0x/utils');
const config_1 = require('../config');
const types_1 = require('../types');
const utils_2 = require('../utils');
class OrderWatcherAdapter {
    constructor(provider, networkId, lifeCycleEventCallback, contractWrappers) {
        this._shadowedOrderHashes = new Map();
        this._orders = new Map();
        this._lifeCycleEventCallback = lifeCycleEventCallback;
        this._orderWatcher = new order_watcher_1.OrderWatcher(provider, networkId);
        this._orderWatcher.subscribe((err, orderState) => {
            if (err) {
                utils_2.utils.log(err);
            } else {
                const state = orderState;
                if (!state.isValid) {
                    this._shadowedOrderHashes.set(state.orderHash, Date.now());
                } else {
                    this._shadowedOrderHashes.delete(state.orderHash);
                }
            }
        });
        utils_1.intervalUtils.setAsyncExcludingInterval(
            async () => {
                const permanentlyExpiredOrders = [];
                for (const [orderHash, shadowedAt] of this._shadowedOrderHashes) {
                    const now = Date.now();
                    if (shadowedAt + config_1.ORDER_SHADOWING_MARGIN_MS < now) {
                        permanentlyExpiredOrders.push(orderHash);
                    }
                }
                if (permanentlyExpiredOrders.length !== 0) {
                    for (const orderHash of permanentlyExpiredOrders) {
                        const order = this._orders.get(orderHash);
                        if (order) {
                            lifeCycleEventCallback(types_1.OrderWatcherLifeCycleEvents.Remove, [order]);
                            this._shadowedOrderHashes.delete(orderHash); // we need to remove this order so we don't keep shadowing it
                            this._orders.delete(orderHash);
                            this._orderWatcher.removeOrder(orderHash); // also remove from order watcher to avoid more callbacks
                        }
                    }
                }
            },
            config_1.PERMANENT_CLEANUP_INTERVAL_MS,
            utils_2.utils.log,
        );
        this._contractWrappers = contractWrappers;
    }
    // tslint:disable-next-line:prefer-function-over-method no-empty
    async fetchOrdersAndCallbackAsync() {}
    async addOrdersAsync(orders) {
        const accepted = [];
        const rejected = [];
        for (const order of orders) {
            try {
                await this._contractWrappers.exchange.validateOrderFillableOrThrowAsync(order, {
                    simulationTakerAddress: config_1.DEFAULT_TAKER_SIMULATION_ADDRESS,
                });
                await this._orderWatcher.addOrderAsync(order);
                accepted.push({ order, message: undefined });
                const orderHash = _0x_js_1.orderHashUtils.getOrderHashHex(order);
                this._orders.set(orderHash, order);
                this._lifeCycleEventCallback(types_1.OrderWatcherLifeCycleEvents.Add, [order]);
            } catch (err) {
                rejected.push({ order, message: err.message });
            }
        }
        return {
            accepted,
            rejected,
        };
    }
    removeOrders(orders) {
        for (const order of orders) {
            const orderHash = _0x_js_1.orderHashUtils.getOrderHashHex(order);
            this._orderWatcher.removeOrder(orderHash);
            this._orders.delete(orderHash);
        }
    }
    orderFilter(order) {
        const orderHash = _0x_js_1.orderHashUtils.getOrderHashHex(order);
        return this._shadowedOrderHashes.has(orderHash);
    }
}
exports.OrderWatcherAdapter = OrderWatcherAdapter;

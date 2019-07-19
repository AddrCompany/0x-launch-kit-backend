"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const order_utils_1 = require("@0x/order-utils");
const _ = require("lodash");
const Web3Providers = require("web3-providers");
const config_1 = require("../config");
const types_1 = require("../types");
const utils_1 = require("../utils");
var OrderEventKind;
(function (OrderEventKind) {
    OrderEventKind["Invalid"] = "INVALID";
    OrderEventKind["Added"] = "ADDED";
    OrderEventKind["Filled"] = "FILLED";
    OrderEventKind["FullyFilled"] = "FULLY_FILLED";
    OrderEventKind["Cancelled"] = "CANCELLED";
    OrderEventKind["Expired"] = "EXPIRED";
    OrderEventKind["Unfunded"] = "UNFUNDED";
    OrderEventKind["FillabilityIncreased"] = "FILLABILITY_INCREASED";
})(OrderEventKind || (OrderEventKind = {}));
var RejectedKind;
(function (RejectedKind) {
    RejectedKind["ZeroexValidation"] = "ZEROEX_VALIDATION";
    RejectedKind["MeshError"] = "MESH_ERROR";
    RejectedKind["MeshValidation"] = "MESH_VALIDATION";
})(RejectedKind || (RejectedKind = {}));
var RejectedCode;
(function (RejectedCode) {
    RejectedCode["InternalError"] = "InternalError";
    RejectedCode["MaxOrderSizeExceeded"] = "MaxOrderSizeExceeded";
    RejectedCode["OrderAlreadyStored"] = "OrderAlreadyStored";
    RejectedCode["OrderForIncorrectNetwork"] = "OrderForIncorrectNetwork";
    RejectedCode["NetworkRequestFailed"] = "NetworkRequestFailed";
    RejectedCode["OrderHasInvalidMakerAssetAmount"] = "OrderHasInvalidMakerAssetAmount";
    RejectedCode["OrderHasInvalidTakerAssetAmount"] = "OrderHasInvalidTakerAssetAmount";
    RejectedCode["OrderExpired"] = "OrderExpired";
    RejectedCode["OrderFullyFilled"] = "OrderFullyFilled";
    RejectedCode["OrderCancelled"] = "OrderCancelled";
    RejectedCode["OrderUnfunded"] = "OrderUnfunded";
    RejectedCode["OrderHasInvalidMakerAssetData"] = "OrderHasInvalidMakerAssetData";
    RejectedCode["OrderHasInvalidTakerAssetData"] = "OrderHasInvalidTakerAssetData";
    RejectedCode["OrderHasInvalidSignature"] = "OrderHasInvalidSignature";
})(RejectedCode || (RejectedCode = {}));
const SLEEP_INTERVAL = 1000;
// Mesh ticks at 5 seconds, allow for a little latency
const HEARTBEAT_INTERVAL = 6000;
const GET_ORDERS_MAX_SIZE = 1000;
const BATCH_SIZE = 1000;
class MeshAdapter {
    constructor(lifeCycleEventCallback) {
        this._isConnectedToMesh = false;
        this._lifeCycleEventCallback = lifeCycleEventCallback;
        void this._connectToMeshAsync();
    }
    async addOrdersAsync(orders) {
        const validationResults = { accepted: [], rejected: [] };
        if (orders.length === 0) {
            return validationResults;
        }
        await this._waitForMeshAsync();
        const orderChunks = _.chunk(orders, BATCH_SIZE);
        for (const chunk of orderChunks) {
            const { accepted, rejected } = await this._submitOrdersToMeshAsync(chunk);
            const adaptAcceptedValidationResults = (accepted || []).map(r => ({
                order: order_utils_1.orderParsingUtils.convertOrderStringFieldsToBigNumber(r.signedOrder),
                message: undefined,
            }));
            const adaptRejectedValidationResults = (rejected || []).map(r => ({
                order: order_utils_1.orderParsingUtils.convertOrderStringFieldsToBigNumber(r.signedOrder),
                message: `${r.kind} ${r.status.code}: ${r.status.message}`,
            }));
            validationResults.accepted = [...validationResults.accepted, ...adaptAcceptedValidationResults];
            validationResults.rejected = [...validationResults.rejected, ...adaptRejectedValidationResults];
        }
        return validationResults;
    }
    // tslint:disable-next-line: prefer-function-over-method no-empty
    removeOrders(_orders) { }
    // tslint:disable-next-line: prefer-function-over-method
    orderFilter(_order) {
        return false;
    }
    async _connectToMeshAsync() {
        while (!this._isConnectedToMesh) {
            try {
                const clientConfig = { fragmentOutgoingMessages: false };
                this._wsClient = new Web3Providers.WebsocketProvider(config_1.MESH_ENDPOINT, {
                    clientConfig: clientConfig,
                });
                const heartbeatSubscriptionId = await this._wsClient.subscribe('mesh_subscribe', 'heartbeat', []);
                this._wsClient.on(heartbeatSubscriptionId, () => (this._lastHeartbeat = new Date()));
                const subscriptionId = await this._wsClient.subscribe('mesh_subscribe', 'orders', []);
                this._wsClient.on(subscriptionId, this._onOrderEventCallbackAsync.bind(this));
                this._isConnectedToMesh = true;
                utils_1.utils.log('Connected to Mesh');
                let heartbeatCheckInterval;
                heartbeatCheckInterval = setInterval(() => {
                    if (this._lastHeartbeat === undefined ||
                        Date.now() - this._lastHeartbeat.valueOf() > HEARTBEAT_INTERVAL) {
                        utils_1.utils.log('Disconnected from Mesh');
                        clearInterval(heartbeatCheckInterval);
                        this._isConnectedToMesh = false;
                        this._lastHeartbeat = undefined;
                        void this._connectToMeshAsync();
                    }
                }, HEARTBEAT_INTERVAL);
                void this._fetchOrdersAsync();
            }
            catch (err) {
                console.log(err);
                await utils_1.utils.sleepAsync(SLEEP_INTERVAL);
            }
        }
    }
    async _onOrderEventCallbackAsync(eventPayload) {
        const addedOrders = [];
        const removedOrders = [];
        for (const event of eventPayload.result) {
            const signedOrder = order_utils_1.orderParsingUtils.convertOrderStringFieldsToBigNumber(event.signedOrder);
            switch (event.kind) {
                case OrderEventKind.Added: {
                    addedOrders.push(signedOrder);
                    break;
                }
                case OrderEventKind.Cancelled:
                case OrderEventKind.Expired:
                case OrderEventKind.FullyFilled:
                case OrderEventKind.Unfunded: {
                    removedOrders.push(signedOrder);
                    break;
                }
                case OrderEventKind.Filled: {
                    break;
                }
                case OrderEventKind.FillabilityIncreased: {
                    addedOrders.push(signedOrder);
                    break;
                }
                default:
                // noop
            }
        }
        if (addedOrders.length > 0) {
            this._lifeCycleEventCallback(types_1.OrderWatcherLifeCycleEvents.Add, addedOrders);
        }
        if (removedOrders.length > 0) {
            this._lifeCycleEventCallback(types_1.OrderWatcherLifeCycleEvents.Remove, removedOrders);
        }
    }
    async _submitOrdersToMeshAsync(signedOrders) {
        await this._waitForMeshAsync();
        const stringifiedSignedOrders = signedOrders.map(stringifyOrder);
        const validationResults = await this._wsClient.send('mesh_addOrders', [
            stringifiedSignedOrders,
        ]);
        return validationResults;
    }
    async _waitForMeshAsync() {
        while (!this._isConnectedToMesh) {
            await utils_1.utils.sleepAsync(SLEEP_INTERVAL);
        }
    }
    async _fetchOrdersAsync() {
        await this._waitForMeshAsync();
        let page = 0;
        // tslint:disable-next-line:prefer-const
        let { ordersInfos, snapshotID } = await this._wsClient.send('mesh_getOrders', [page, GET_ORDERS_MAX_SIZE, '']);
        do {
            const signedOrders = ordersInfos.map((o) => order_utils_1.orderParsingUtils.convertOrderStringFieldsToBigNumber(o.signedOrder));
            this._lifeCycleEventCallback(types_1.OrderWatcherLifeCycleEvents.Add, signedOrders);
            page++;
            ordersInfos = (await this._wsClient.send('mesh_getOrders', [page, GET_ORDERS_MAX_SIZE, snapshotID]))
                .ordersInfos;
        } while (Object.keys(ordersInfos).length > 0);
    }
}
exports.MeshAdapter = MeshAdapter;
const stringifyOrder = (signedOrder) => {
    const stringifiedSignedOrder = {
        signature: signedOrder.signature,
        senderAddress: signedOrder.senderAddress,
        makerAddress: signedOrder.makerAddress,
        takerAddress: signedOrder.takerAddress,
        makerFee: signedOrder.makerFee.toString(),
        takerFee: signedOrder.takerFee.toString(),
        makerAssetAmount: signedOrder.makerAssetAmount.toString(),
        takerAssetAmount: signedOrder.takerAssetAmount.toString(),
        makerAssetData: signedOrder.makerAssetData,
        takerAssetData: signedOrder.takerAssetData,
        salt: signedOrder.salt.toString(),
        exchangeAddress: signedOrder.exchangeAddress,
        feeRecipientAddress: signedOrder.feeRecipientAddress,
        expirationTimeSeconds: signedOrder.expirationTimeSeconds.toString(),
    };
    return stringifiedSignedOrder;
};

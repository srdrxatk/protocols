import { BigNumber } from "bignumber.js";
import BN = require("bn.js");
import { Bitstream } from "./bitstream";
import { Context } from "./context";
import { ensure } from "./ensure";
import { ExchangeDeserializer } from "./exchange_deserializer";
import { Mining } from "./mining";
import { OrderUtil } from "./order";
import { Ring } from "./ring";
import { OrderInfo, RingMinedEvent, RingsInfo, SimulatorReport, Spendable,
         TransactionPayments, TransferItem } from "./types";
import { xor } from "./xor";

export class ProtocolSimulator {

  public context: Context;
  public offLineMode: boolean = false;

  private ringIndex: number = 0;
  private orderUtil: OrderUtil;

  constructor(context: Context) {
    this.context = context;
    this.orderUtil = new OrderUtil(context);
  }

  public deserialize(data: string,
                     transactionOrigin: string) {
    const exchangeDeserializer = new ExchangeDeserializer(this.context);
    const [mining, orders, rings] = exchangeDeserializer.deserialize(data);

    const ringsInfo: RingsInfo = {
      rings,
      orders,
      feeRecipient: mining.feeRecipient,
      miner: mining.miner,
      sig: mining.sig,
      transactionOrigin,
    };
    return ringsInfo;
  }

  public async simulateAndReport(ringsInfo: RingsInfo) {
    const mining = new Mining(
      this.context,
      ringsInfo.feeRecipient ? ringsInfo.feeRecipient : ringsInfo.transactionOrigin,
      ringsInfo.miner,
      ringsInfo.sig,
    );

    const orders = ringsInfo.orders;

    const rings: Ring[] = [];
    for (const indexes of ringsInfo.rings) {
      const ringOrders: OrderInfo[] = [];
      for (const orderIndex of indexes) {
        const orderInfo = ringsInfo.orders[orderIndex];
        ringOrders.push(orderInfo);
      }
      const ring = new Ring(
        this.context,
        ringOrders,
      );
      rings.push(ring);
    }

    for (const order of orders) {
      order.valid = true;
      await this.orderUtil.validateInfo(order);
      this.orderUtil.checkP2P(order);
      order.hash = this.orderUtil.getOrderHash(order);
      await this.orderUtil.updateBrokerAndInterceptor(order);
    }
    await this.batchGetFilledAndCheckCancelled(orders);
    this.updateBrokerSpendables(orders);
    for (const order of orders) {
      await this.orderUtil.checkBrokerSignature(order);
    }

    for (const ring of rings) {
      ring.updateHash();
    }

    mining.updateHash(rings);
    await mining.updateMinerAndInterceptor();
    assert(mining.checkMinerSignature(ringsInfo.transactionOrigin) === true,
           "Invalid miner signature");

    for (const order of orders) {
      this.orderUtil.checkDualAuthSignature(order, mining.hash);
    }

    const ringMinedEvents: RingMinedEvent[] = [];
    const transferItems: TransferItem[] = [];
    const feeBalances: { [id: string]: any; } = {};
    for (const ring of rings) {
      ring.checkOrdersValid();
      ring.checkForSubRings();
      await ring.calculateFillAmountAndFee();
      if (ring.valid) {
        ring.adjustOrderStates();
      }
    }

    for (const order of orders) {
      // Check if this order needs to be completely filled
      if (order.allOrNone) {
        order.valid = order.valid && (order.filledAmountS === order.amountS);
      }
    }

    for (const ring of rings) {
      const validBefore = ring.valid;
      ring.checkOrdersValid();
      if (ring.valid) {
        const ringReport = await this.simulateAndReportSingle(ring, mining, feeBalances);
        ringMinedEvents.push(ringReport.ringMinedEvent);
        // Merge transfer items if possible
        for (const ringTransferItem of ringReport.transferItems) {
          let addNew = true;
          for (const transferItem of transferItems) {
            if (transferItem.token === ringTransferItem.token &&
                transferItem.from === ringTransferItem.from &&
                transferItem.to === ringTransferItem.to) {
                transferItem.amount += ringTransferItem.amount;
                addNew = false;
            }
          }
          if (addNew) {
            transferItems.push(ringTransferItem);
          }
        }
      } else {
        // If the ring was valid before the completely filled check we have to revert the filled amountS
        // of the orders in the ring. This is a bit awkward so maybe there's a better solution.
        if (validBefore) {
          for (const p of ring.participations) {
                p.order.filledAmountS = p.order.filledAmountS - (p.fillAmountS + p.splitS);
                assert(p.order.filledAmountS >= 0, "p.order.filledAmountS >= 0");
            }
        }
      }
    }

    const balancesBefore: { [id: string]: any; } = {};
    for (const order of orders) {
      if (!balancesBefore[order.tokenS]) {
        balancesBefore[order.tokenS] = {};
      }
      if (!balancesBefore[order.tokenB]) {
        balancesBefore[order.tokenB] = {};
      }
      if (!balancesBefore[order.feeToken]) {
        balancesBefore[order.feeToken] = {};
      }
      if (!balancesBefore[order.tokenS][order.owner]) {
        balancesBefore[order.tokenS][order.owner] =
          await this.orderUtil.getERC20Spendable(this.context.tradeDelegate.address,
                                                  order.tokenS,
                                                  order.owner);
      }
      if (!balancesBefore[order.tokenB][order.tokenRecipient]) {
        balancesBefore[order.tokenB][order.tokenRecipient] =
          await this.orderUtil.getERC20Spendable(this.context.tradeDelegate.address,
                                                 order.tokenB,
                                                 order.tokenRecipient);
      }
      if (!balancesBefore[order.feeToken][order.owner]) {
        balancesBefore[order.feeToken][order.owner] =
          await this.orderUtil.getERC20Spendable(this.context.tradeDelegate.address,
                                                 order.feeToken,
                                                 order.owner);
      }
    }

    // Simulate the token transfers of all rings
    const balanceDeltas: { [id: string]: any; } = {};
    for (const transfer of transferItems) {
      if (!balanceDeltas[transfer.token]) {
        balanceDeltas[transfer.token] = {};
      }
      if (!balanceDeltas[transfer.token][transfer.from]) {
        balanceDeltas[transfer.token][transfer.from] = 0;
      }
      if (!balanceDeltas[transfer.token][transfer.to]) {
        balanceDeltas[transfer.token][transfer.to] = 0;
      }
      balanceDeltas[transfer.token][transfer.from] -= transfer.amount;
      balanceDeltas[transfer.token][transfer.to] += transfer.amount;
    }

    const balancesAfter: { [id: string]: any; } = {};
    for (const token of Object.keys(balancesBefore)) {
      for (const owner of Object.keys(balancesBefore[token])) {
        if (!balancesAfter[token]) {
          balancesAfter[token] = {};
        }
        const delta = (balanceDeltas[token] && balanceDeltas[token][owner]) ? balanceDeltas[token][owner] : 0;
        balancesAfter[token][owner] = balancesBefore[token][owner] + delta;

        // Check if we haven't spent more funds than the owner owns
        const epsilon = 1000;
        assert(balancesAfter[token][owner] >= -epsilon, "can't sell more tokens than the owner owns");
      }
    }

    // Check if the spendables were updated correctly
    for (const order of orders) {
      if (order.tokenSpendableS.initialized) {
        let amountTransferredS = 0;
        for (const transfer of transferItems) {
          if (transfer.from === order.owner && transfer.token === order.tokenS) {
            amountTransferredS += transfer.amount;
          }
        }
        const amountSpentS = order.tokenSpendableS.initialAmount - order.tokenSpendableS.amount;
        // amountTransferred could be less than amountSpent because of rebates
        const epsilon = 100000;
        assert(amountSpentS >= amountTransferredS - epsilon, "amountSpentS >= amountTransferredS");
      }
      if (order.tokenSpendableFee.initialized) {
        let amountTransferredFee = 0;
        for (const transfer of transferItems) {
          if (transfer.from === order.owner && transfer.token === order.feeToken) {
            amountTransferredFee += transfer.amount;
          }
        }
        const amountSpentFee = order.tokenSpendableFee.initialAmount - order.tokenSpendableFee.amount;
        // amountTransferred could be less than amountSpent because of rebates
        const epsilon = 100000;
        assert(amountSpentFee >= amountTransferredFee - epsilon, "amountSpentFee >= amountTransferredFee");
      }
    }

    // Check if the allOrNone orders were correctly filled
    for (const order of orders) {
      if (order.allOrNone) {
        assert(order.filledAmountS === 0 || order.filledAmountS === order.amountS,
               "allOrNone orders should either be completely fill or not at all.");
      }
    }

    const filledAmounts: { [hash: string]: number; } = {};
    for (const order of orders) {
      let filledAmountS = order.filledAmountS ? order.filledAmountS : 0;
      if (!order.valid) {
        filledAmountS = await this.context.tradeDelegate.filled("0x" + order.hash.toString("hex")).toNumber();
      }
      filledAmounts[order.hash.toString("hex")] = filledAmountS;
    }

    const payments: TransactionPayments = {
      rings: [],
    };
    for (const ring of rings) {
      payments.rings.push(ring.payments);
    }

    const simulatorReport: SimulatorReport = {
      ringMinedEvents,
      transferItems,
      feeBalances,
      filledAmounts,
      balancesBefore,
      balancesAfter,
      payments,
    };
    return simulatorReport;
  }

  private async simulateAndReportSingle(ring: Ring, mining: Mining, feeBalances: { [id: string]: any; }) {
    const transferItems = await ring.doPayments(mining, feeBalances);
    const ringMinedEvent: RingMinedEvent = {
      ringIndex: new BigNumber(this.ringIndex++),
    };
    return {ringMinedEvent, transferItems};
  }

  private async batchGetFilledAndCheckCancelled(orders: OrderInfo[]) {
    const bitstream = new Bitstream();
    for (const order of orders) {
      bitstream.addAddress(order.broker, 32);
      bitstream.addAddress(order.owner, 32);
      bitstream.addHex(order.hash.toString("hex"));
      bitstream.addNumber(order.validSince, 32);
      bitstream.addHex(xor(order.tokenS, order.tokenB, 20));
      bitstream.addNumber(0, 12);
    }

    const fills = await this.context.tradeDelegate.batchGetFilledAndCheckCancelled(bitstream.getBytes32Array());

    const cancelledValue = new BigNumber("F".repeat(64), 16);
    for (const [i, order] of orders.entries()) {
      order.filledAmountS = fills[i].toNumber();
      order.valid = order.valid && ensure(!fills[i].equals(cancelledValue), "order is cancelled");
    }
  }

  private updateBrokerSpendables(orders: OrderInfo[]) {
    // Spendables for brokers need to be setup just right for the allowances to work, we cannot trust
    // the miner to do this for us. Spendables for tokens don't need to be correct, if they are incorrect
    // the transaction will fail, so the miner will want to send those correctly.
    interface BrokerSpendable {
      broker: string;
      owner: string;
      token: string;
      spendable: Spendable;
    }

    const brokerSpendables: BrokerSpendable[] = [];
    const addBrokerSpendable = (broker: string, owner: string, token: string) => {
      // Find an existing one
      for (const spendable of brokerSpendables) {
        if (spendable.broker === broker && spendable.owner === owner && spendable.token === token) {
          return spendable.spendable;
        }
      }
      // Create a new one
      const newSpendable = {
        initialized: false,
        amount: 0,
        reserved: 0,
      };
      const newBrokerSpendable = {
        broker,
        owner,
        token,
        spendable: newSpendable,
      };
      brokerSpendables.push(newBrokerSpendable);
      return newBrokerSpendable.spendable;
    };

    for (const order of orders) {
      if (order.brokerInterceptor) {
        order.brokerSpendableS = addBrokerSpendable(order.broker, order.owner, order.tokenS);
        order.brokerSpendableFee = addBrokerSpendable(order.broker, order.owner, order.feeToken);
      }
    }
  }
}

/*!
 * test/node-http-test.js - test for wallet http endoints
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {NodeClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const Mnemonic = require('../lib/hd/mnemonic');
const Witness = require('../lib/script/witness');
const Script = require('../lib/script/script');
const HDPrivateKey = require('../lib/hd/private');
const Output = require('../lib/primitives/output');
const Coin = require('../lib/primitives/coin');
const MTX = require('../lib/primitives/mtx');
const KeyRing = require('../lib/primitives/keyring');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
const mnemonics = require('./data/mnemonic-english.json');
const consensus = require('../lib/protocol/consensus');
// Commonly used test mnemonic
const phrase = mnemonics[0][1];

const network = Network.get('regtest');
const {types} = rules;

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  indexTx: true,
  indexAddress: true,
  rejectAbsurdFees: false
});

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

let cbAddress, privkey, pubkey;
let socketData, mempoolData;

const {treeInterval} = network.names;

describe('Node HTTP', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await nclient.call('watch chain');

    const mnemonic = Mnemonic.fromPhrase(phrase);
    const priv = HDPrivateKey.fromMnemonic(mnemonic);
    const type = network.keyPrefix.coinType;
    const key = priv.derive(44, true).derive(type, true).derive(0, true);
    const xkey = key.derive(0).derive(0);

    pubkey = xkey.publicKey;
    privkey = xkey.privateKey;

    cbAddress = Address.fromPubkey(pubkey).toString(network.type);

    nclient.bind('tree commit', (root, entry, block) => {
      assert.ok(root);
      assert.ok(block);
      assert.ok(entry);

      socketData.push({root, entry, block});
    });

    node.mempool.on('tx', (tx) => {
      mempoolData[tx.txid()] = true;
    });
  });

  beforeEach(() => {
    socketData = [];
    mempoolData = {};
  });

  after(async () => {
    await nclient.close();
    await node.close();
  });

  describe('JSON API', function () {
    it('should get balance by address', async () => {
      // Generate new cbAddress.
      const cType = network.keyPrefix.coinType;
      const nType = network.type;
      const master = HDPrivateKey.generate();
      const key = master.derivePath(`m/44'/${cType}'/0'/0/0`);
      const cbAddress = Address.fromPubkey(key.publicKey).toString(nType);
      const keyring = KeyRing.fromPrivate(key.privateKey);

      {
        // Get balance & verify balance is zero.
        const balance = await nclient.get(`/balance/${cbAddress}`);
        assert.equal(node.chain.height, balance.height);
        assert.equal(0, balance.balance);
        assert.equal(0, balance.coins.length);
        assert.equal(0, balance.lockedBalance);
        assert.equal(0, balance.lockedCoins.length);
      }

      {
        // Fund address & verify balance.
        const nextInterval = treeInterval;
        const addedReward = nextInterval * consensus.BASE_REWARD;
        const oBalance = await nclient.get(`/balance/${cbAddress}`);
        await mineBlocks(nextInterval, cbAddress);
        const nBalance = await nclient.get(`/balance/${cbAddress}`);

        assert.equal(oBalance.height + nextInterval, nBalance.height);
        assert.equal(oBalance.balance + addedReward, nBalance.balance);
        assert.equal(oBalance.coins.length + nextInterval, nBalance.coins.length);
        assert.equal(oBalance.lockedBalance, nBalance.lockedBalance);
        assert.equal(oBalance.lockedCoins.length, nBalance.lockedCoins.length);
      }

      const name = await nclient.execute('grindname', [5]);
      const rawName = Buffer.from(name, 'ascii');
      const nameHash = rules.hashName(rawName);

      {
        // Create open.
        const coins = await nclient.getCoinsByAddresses([cbAddress]);
        coins.sort((a, b) => a.height - b.height);
        const mtx = new MTX();
        mtx.addCoin(Coin.fromJSON(coins[0]));
        mtx.addOutput(new Output({
          address: cbAddress,
          value: 0,
          covenant: {
            type: types.OPEN,
            items: [nameHash, Buffer.alloc(4), rawName]
          }
        }));
        mtx.addOutput(new Output({
          address: cbAddress,
          value: 1999986000,
          covenant: {
            type: types.NONE,
            items: []
          }
        }));
        mtx.sign(keyring);
        assert(mtx.verify());

        // Mine to next interval & verify balance.
        const nextInterval = treeInterval + 1;
        const addedReward = nextInterval * consensus.BASE_REWARD;
        const oBalance = await nclient.get(`/balance/${cbAddress}`);
        await node.sendTX(mtx.toTX());
        await mineBlocks(nextInterval, cbAddress);
        const nBalance = await nclient.get(`/balance/${cbAddress}`);

        assert.equal(oBalance.height + nextInterval, nBalance.height);
        assert.equal(oBalance.balance + addedReward, nBalance.balance);
        assert.equal(oBalance.coins.length + nextInterval, nBalance.coins.length);
        assert.equal(oBalance.lockedBalance, nBalance.lockedBalance);
        assert.equal(oBalance.lockedCoins.length + 1, nBalance.lockedCoins.length);
      }

      {
        // Create bid.
        const coins = await nclient.getCoinsByAddresses([cbAddress]);
        coins.sort((a, b) => a.height - b.height);
        const covenants = coins.filter((coin) => {
          return coin.covenant.type === types.OPEN;
        });
        const mtx = new MTX();
        const ns = await mtx.view.getNameState(node.chain.db, nameHash);
        const height = Buffer.from([ns.height, 0x00, 0x00, 0x00]);
        const hash = Buffer.alloc(32);
        const lockup = 1999986000;

        mtx.addCoin(Coin.fromJSON(covenants[0]));
        mtx.addCoin(Coin.fromJSON(coins[0]));
        mtx.addOutput(new Output({
          address: cbAddress,
          value: lockup,
          covenant: {
            type: types.BID,
            items: [nameHash, height, rawName, hash]
          }
        }));
        mtx.sign(keyring);
        assert(mtx.verify());

        // Mine to next interval & verify balance.
        const nextInterval = treeInterval;
        const addedReward = nextInterval * consensus.BASE_REWARD;
        const oBalance = await nclient.get(`/balance/${cbAddress}`);
        await node.sendTX(mtx.toTX());
        await mineBlocks(nextInterval, cbAddress);
        const nBalance = await nclient.get(`/balance/${cbAddress}`);

        assert.equal(oBalance.height + nextInterval, nBalance.height);
        assert.equal(oBalance.balance + addedReward - lockup, nBalance.balance);
        assert.equal(oBalance.coins.length + nextInterval - 1, nBalance.coins.length);
        assert.equal(oBalance.lockedBalance + lockup, nBalance.lockedBalance);
        assert.equal(oBalance.lockedCoins.length, nBalance.lockedCoins.length);
      }
    });
  });

  describe('Websockets', function () {
    describe('tree commit', () => {
      it('should mine 1 tree interval', async () => {
        const nextInterval = treeInterval - (node.chain.height % treeInterval);
        await mineBlocks(nextInterval, cbAddress);
        assert.equal(socketData.length, 1);
      });

      it('should send the correct tree root', async () => {
        const name = await nclient.execute('grindname', [5]);
        const rawName = Buffer.from(name, 'ascii');
        const nameHash = rules.hashName(rawName);

        const u32 = Buffer.alloc(4);
        bio.writeU32(u32, 0, 0);

        const output = new Output({
          address: cbAddress,
          value: 0,
          covenant: {
            type: types.OPEN,
            items: [nameHash, u32, rawName]
          }
        });

        const mtx = new MTX();
        mtx.addOutput(output);

        const coins = await nclient.getCoinsByAddresses([cbAddress]);
        coins.sort((a, b) => a.height - b.height);
        const coin = Coin.fromJSON(coins[0]);

        assert.ok(node.chain.height > coin.height + network.coinbaseMaturity);
        mtx.addCoin(coin);

        const addr = Address.fromPubkey(pubkey);
        const script = Script.fromPubkeyhash(addr.hash);

        const sig = mtx.signature(0, script, coin.value, privkey);
        mtx.inputs[0].witness = Witness.fromItems([sig, pubkey]);

        const valid = mtx.verify();
        assert.ok(valid);

        const tx = mtx.toTX();
        await node.sendTX(tx);

        await common.forValue(mempoolData, tx.txid(), true);

        const pre = await nclient.getInfo();

        const mempool = await nclient.getMempool();
        assert.equal(mempool[0], mtx.txid());

        await mineBlocks(treeInterval, cbAddress);
        assert.equal(socketData.length, 1);

        const {root, block, entry} = socketData[0];
        assert.bufferEqual(node.chain.db.treeRoot(), root);

        const info = await nclient.getInfo();
        assert.notEqual(pre.chain.tip, info.chain.tip);

        assert.equal(info.chain.tip, block.hash);
        assert.equal(info.chain.tip, entry.hash);
      });
    });
  });
});

// take into account race conditions
async function mineBlocks(count, address) {
  for (let i = 0; i < count; i++) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await common.forValue(obj, 'complete', true);
  }
}

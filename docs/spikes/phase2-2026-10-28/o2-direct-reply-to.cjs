const amqp = require('amqplib');
const URL = process.env.AMQP_URL ?? 'amqp://test:test@127.0.0.1:5672';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function serverPublish(ch, label, routingKey) {
  const returned = new Promise(resolve => {
    const onReturn = (msg) => { if (msg.properties.messageId === label) { ch.removeListener('return', onReturn); resolve({ replyCode: msg.fields.replyCode, replyText: msg.fields.replyText }); } };
    ch.on('return', onReturn);
    setTimeout(() => resolve(null), 1500);
  });
  const confirmed = new Promise(resolve => {
    ch.publish('', routingKey, Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'), { mandatory: true, messageId: label }, (err) => resolve(err ? 'nack' : 'ack'));
  });
  const [ret, conf] = await Promise.all([returned, confirmed]);
  console.log(`${label.padEnd(34)} confirm=${conf}  return=${ret ? `${ret.replyCode} ${ret.replyText}` : 'none (delivered or silently dropped)'}`);
  return { ret, conf };
}

(async () => {
  const server = await amqp.connect(URL);
  const sch = await server.createConfirmChannel();
  const results = {};

  // 1. Live direct reply-to: client consumes, server replies -> should be delivered.
  {
    const c = await amqp.connect(URL); const ch = await c.createChannel();
    let got = 0;
    await ch.consume('amq.rabbitmq.reply-to', () => { got++; }, { noAck: true });
    const q = await sch.assertQueue('', { exclusive: true }); // "request queue" stand-in
    let replyTo;
    await sch.consume(q.queue, (m) => { replyTo = m.properties.replyTo; sch.ack(m); });
    ch.sendToQueue(q.queue, Buffer.from('req'), { replyTo: 'amq.rabbitmq.reply-to' });
    for (let i = 0; i < 20 && !replyTo; i++) await sleep(50);
    console.log('direct reply-to address seen by server:', replyTo);
    results.live = await serverPublish(sch, 'live-direct-reply-to', replyTo);
    await sleep(200);
    console.log('  client received:', got);
    // 2. Stale: close the client CHANNEL only, connection stays open.
    await ch.close();
    await sleep(300);
    results.staleChannel = await serverPublish(sch, 'stale-direct-reply-to(channel)', replyTo);
    // 3. Stale: close the whole connection.
    await c.close();
    await sleep(300);
    results.staleConn = await serverPublish(sch, 'stale-direct-reply-to(connection)', replyTo);
  }
  // 4. Forged/never-existing direct reply-to name.
  results.forged = await serverPublish(sch, 'forged-direct-reply-to', 'amq.rabbitmq.reply-to.g1h2AAAAAAAAAAAAAAAAAAA.bogusbogusbogus==');
  // 5. Stale exclusive named reply queue (control).
  {
    const c = await amqp.connect(URL); const ch = await c.createChannel();
    const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    await c.close(); await sleep(300);
    results.staleQueue = await serverPublish(sch, 'stale-exclusive-queue', q.queue);
  }
  // 6. Never-existing named queue.
  results.missing = await serverPublish(sch, 'missing-named-queue', 'no-such-queue-xyz');

  await server.close();
  console.log(JSON.stringify(results));
})().catch(e => { console.error(e); process.exit(1); });

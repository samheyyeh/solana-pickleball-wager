import { useState, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { generateKeyPairSigner } from "gill";
import * as ed25519 from "@noble/ed25519";
import bs58 from "bs58";

const encoder = new TextEncoder();
function toHex(u: Uint8Array) {
  return Buffer.from(u).toString("hex");
}

type SignatureInfo = { signature: string; valid: boolean };

export default function App() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signMessage } = useWallet();

  const [escrow, setEscrow] = useState<Keypair | null>(null);
  const [mode, setMode] = useState<"singles" | "doubles">("singles");
  const [playerNames, setPlayerNames] = useState<Record<string, string>>({
    playerA1: "",
    playerA2: "",
    playerB1: "",
    playerB2: "",
  });
  const [players, setPlayers] = useState<Record<string, any>>({});
  const [score, setScore] = useState("");
  const [message, setMessage] = useState("");
  const [signatures, setSignatures] = useState<Record<string, SignatureInfo>>({});
  const [winner, setWinner] = useState("");
  const [confirming, setConfirming] = useState<{ label: string; player: any } | null>(null);

  useEffect(() => {
    (async () => {
      if (publicKey) {
        await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
      }

      const kp = Keypair.generate();
      setEscrow(kp);
    })();
  }, [publicKey]);

  const handleName = (k: string, v: string) =>
    setPlayerNames((p) => ({ ...p, [k]: v }));

  const mintPlayers = async () => {
    if (
      !playerNames.playerA1 ||
      !playerNames.playerB1 ||
      (mode === "doubles" &&
        (!playerNames.playerA2 || !playerNames.playerB2))
    )
      return alert("Fill all names");

    if (!publicKey) return alert("Connect your wallet first.");

    const p: Record<string, any> = {};

    // Player A1 uses real connected wallet
    p[playerNames.playerA1] = {
      address: publicKey.toBase58(),
      real: true,
    };

    // Other players are simulated
    p[playerNames.playerB1] = await generateKeyPairSigner();
    if (mode === "doubles") {
      p[playerNames.playerA2] = await generateKeyPairSigner();
      p[playerNames.playerB2] = await generateKeyPairSigner();
    }

    setPlayers(p);
    setSignatures({});
    setMessage("");
    setScore("");
    setWinner("");
  };

  const prepMessage = (w: string) => {
    if (!score) return;
    const msg = `Pickleball result: ${w} wins. Final score: ${score}`;
    setMessage(msg);
    setWinner(w);
  };

  const signMessageForPlayer = async (label: string, player: any) => {
    const m = encoder.encode(message);
    let sig: Uint8Array;

    try {
      if (player.real && signMessage) {
        // Real wallet signs via Phantom
        const signed = await signMessage(m);
        sig = new Uint8Array(signed);
      } else if (player.signMessages) {
        // Simulated signer
        const [signed] = await player.signMessages([{ content: m, signatures: {} }]);
        sig = signed[player.address];
      } else {
        throw new Error("Unknown signer type");
      }

      const valid = await ed25519.verify(sig, m, bs58.decode(player.address));
      setSignatures((prev) => ({
        ...prev,
        [label]: { signature: toHex(sig), valid },
      }));

      console.log(`✅ ${label} signed. Valid: ${valid}`);
    } catch (e) {
      console.error(`❌ ${label} failed to sign:`, e);
      alert(`Failed to sign message as ${label}`);
    }

    setConfirming(null);

    const totalPlayers = Object.keys(players).length;
    const totalSigs = Object.keys(signatures).length + 1;
    if (totalSigs >= totalPlayers) {
      console.log("🎯 All players signed. Triggering payout...");
      await payoutWinner();
    }
  };

  const payoutWinner = async () => {
    if (!escrow || !winner || !publicKey) return;

    const winnerInfo = players[winner];
    if (!winnerInfo) return alert("Winner info missing");

    const winnerPk = new PublicKey(winnerInfo.address);
    const bal = await connection.getBalance(escrow.publicKey);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: escrow.publicKey,
        toPubkey: winnerPk,
        lamports: bal - 5000,
      })
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [escrow]);
      console.log("✅ Payout tx signature:", sig);
      alert(`Paid ${bal / LAMPORTS_PER_SOL} SOL to ${winner}`);
    } catch (e) {
      console.error("❌ Payout failed:", e);
      alert("Payout failed. Check console.");
    }
  };

  const depositToEscrow = async () => {
    if (!publicKey || !escrow) return alert("Connect your wallet first.");

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: escrow.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );

    try {
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      alert("✅ Deposit successful!");
      console.log("Deposit transaction:", sig);
    } catch (err) {
      console.error("Deposit failed:", err);
      alert("❌ Deposit failed.");
    }
  };

  const renderPlayer = (label: string) => {
    if (!players[label]) return null;
    return (
      <div key={label}>
        <strong>{label}</strong>: {players[label].address}
        <button onClick={() => setConfirming({ label, player: players[label] })}>
          Sign
        </button>
        {signatures[label] && <span> ✅</span>}
      </div>
    );
  };

  return (
    <div>
      <WalletMultiButton />
      <h2>🏓 Pickleball Wager</h2>

      {publicKey && escrow && (
        <div>
          <p>Vault Wallet: {escrow.publicKey.toBase58()}</p>
          <button onClick={depositToEscrow}>Deposit 0.05 SOL to Vault</button>
        </div>
      )}

      <div>
        <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
          <option value="singles">Singles</option>
          <option value="doubles">Doubles</option>
        </select>

        <input
          placeholder="A1 (You)"
          onChange={(e) => handleName("playerA1", e.target.value)}
        />
        <input
          placeholder="B1"
          onChange={(e) => handleName("playerB1", e.target.value)}
        />
        {mode === "doubles" && (
          <>
            <input
              placeholder="A2"
              onChange={(e) => handleName("playerA2", e.target.value)}
            />
            <input
              placeholder="B2"
              onChange={(e) => handleName("playerB2", e.target.value)}
            />
          </>
        )}
        <button onClick={mintPlayers}>Generate Keys</button>
      </div>

      <div>{Object.keys(players).map(renderPlayer)}</div>

      {Object.keys(players).length >= (mode === "singles" ? 2 : 4) && (
        <>
          <input
            placeholder="Score (e.g. 11-7)"
            value={score}
            onChange={(e) => setScore(e.target.value)}
          />
          {Object.keys(players).map((p) => (
            <button key={p} onClick={() => prepMessage(p)} disabled={!score}>
              {p} Wins
            </button>
          ))}
          {message && <div><strong>Message:</strong> {message}</div>}
        </>
      )}

      {confirming && (
        <div>
          <p>Sign as {confirming.label}?</p>
          <button onClick={() => signMessageForPlayer(confirming.label, confirming.player)}>
            Yes
          </button>
          <button onClick={() => setConfirming(null)}>No</button>
        </div>
      )}
    </div>
  );
}

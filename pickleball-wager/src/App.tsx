import { useEffect, useState, useRef } from "react";
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
import * as ed25519 from "@noble/ed25519";
import bs58 from "bs58";
import { supabase } from "./lib/supabase";
import { v4 as uuidv4 } from "uuid";

const encoder = new TextEncoder();
function toHex(u: Uint8Array) {
  return Buffer.from(u).toString("hex");
}

type Match = {
  id: string;
  players: Record<string, { address: string; name: string }>;
  signatures: Record<string, { signature: string; valid: boolean }>;
  winner: string;
  score: string;
  message: string;
  escrow: { pub: string; secret: string };
};

export default function App() {
  const { connection } = useConnection();
  const { publicKey, signMessage, sendTransaction } = useWallet();

  const [wager, setWager] = useState(".05");

  const [escrow, setEscrow] = useState<Keypair | null>(null);
  const [lobbyCode, setLobbyCode] = useState("");
  const [match, setMatch] = useState<Match | null>(null);
  const [score, setScore] = useState("");
  const [joiningCode, setJoiningCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [loading, setLoading] = useState(false);
  const payoutTriggered = useRef(false);

  const yourPlayerKey = match
    ? Object.keys(match.players).find(
        (k) => match.players[k].address === publicKey?.toBase58()
      )
    : undefined;

  // Setup realtime subscription to match updates
  useEffect(() => {
    if (!lobbyCode) return;

    payoutTriggered.current = false; // Reset payout trigger on new lobby join

    const channel = supabase
      .channel("match-updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${lobbyCode}` },
        (payload) => {
          console.log("Realtime update received:", payload.new);
          const data = payload.new as Match;
          setMatch(data);
          setEscrow(Keypair.fromSecretKey(bs58.decode(data.escrow.secret)));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [lobbyCode]);

  // Manual polling fallback every 5s to catch missed updates
  useEffect(() => {
    if (!lobbyCode) return;

    const interval = setInterval(async () => {
      const { data, error } = await supabase
        .from("matches")
        .select("*")
        .eq("id", lobbyCode)
        .single();
      if (!error && data) {
        setMatch(data);
        setEscrow(Keypair.fromSecretKey(bs58.decode(data.escrow.secret)));
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [lobbyCode]);

  // Create Lobby
  const createLobby = async () => {
    if (!publicKey || !playerName) return alert("Enter your name and connect wallet");
    setLoading(true);
    const code = uuidv4().slice(0, 6);
    const kp = Keypair.generate();

    const newMatch: Match = {
      id: code,
      players: {
        A1: { address: publicKey.toBase58(), name: playerName },
      },
      signatures: {},
      winner: "",
      score: "",
      message: "",
      escrow: {
        pub: kp.publicKey.toBase58(),
        secret: bs58.encode(kp.secretKey),
      },
    };

    const { error } = await supabase.from("matches").insert([newMatch]);
    if (error) {
      console.error("Error creating match:", error);
      setLoading(false);
      return;
    }

    setLobbyCode(code);
    setMatch(newMatch);
    setEscrow(kp);
    setLoading(false);
  };

  // Join Lobby
  const joinLobby = async () => {
    if (!joiningCode || !publicKey || !playerName) return alert("Enter your name, connect wallet, and enter a lobby code");
    setLoading(true);

    const { data, error } = await supabase
      .from("matches")
      .select("*")
      .eq("id", joiningCode)
      .single();

    if (error || !data) {
      alert("Lobby not found");
      setLoading(false);
      return;
    }

    const players = data.players;

    if (!Object.keys(players).includes("B1")) {
      players.B1 = { address: publicKey.toBase58(), name: playerName };
      const { error: updateError } = await supabase.from("matches").update({ players }).eq("id", joiningCode);
      if (updateError) {
        alert("Failed to join lobby");
        setLoading(false);
        return;
      }
    }

    // Fetch updated match data after join to refresh UI
    const { data: updatedMatch, error: fetchError } = await supabase
      .from("matches")
      .select("*")
      .eq("id", joiningCode)
      .single();

    if (fetchError || !updatedMatch) {
      alert("Failed to refresh lobby");
      setLoading(false);
      return;
    }

    setLobbyCode(joiningCode);
    setMatch(updatedMatch);
    setEscrow(Keypair.fromSecretKey(bs58.decode(updatedMatch.escrow.secret)));
    setLoading(false);
  };

  // Prepare message with winner and score
  const prepMessage = async (winner: string) => {
    if (!score || !lobbyCode || !match) return;

    const msg = `Pickleball result: ${winner} wins. Final score: ${score}`;
    setLoading(true);

    const { error } = await supabase
      .from("matches")
      .update({ winner, message: msg, score })
      .eq("id", lobbyCode);

    if (error) {
      console.error("Error setting winner:", error);
      alert("Failed to set match result.");
    } else {
      setMatch((prev) =>
        prev ? { ...prev, winner, message: msg, score } : prev
      );
    }
    setLoading(false);
  };

  // Player signs the message
  const signMessageForPlayer = async () => {
    if (!match || !match.message || !match.players || !publicKey || !lobbyCode)
      return;

    const playerKey = Object.keys(match.players).find(
      (k) => match.players[k].address === publicKey.toBase58()
    );
    if (!playerKey) return;

    const m = encoder.encode(match.message);
    let sig: Uint8Array;

    try {
      const signed = await signMessage!(m);
      sig = new Uint8Array(signed);

      // Verify signature (using public key of signer)
      // Note: ed25519.verify expects the public key as bytes
      const pubKeyBytes = bs58.decode(publicKey.toBase58());
      const valid = await ed25519.verify(sig, m, pubKeyBytes);
      const hexSig = toHex(sig);

      const updatedSigs = { ...match.signatures, [playerKey]: { signature: hexSig, valid } };

      const { error } = await supabase
        .from("matches")
        .update({ signatures: updatedSigs })
        .eq("id", lobbyCode);

      if (error) {
        console.error("Error updating signature:", error);
        return;
      }

      setMatch((prev) =>
        prev ? { ...prev, signatures: updatedSigs } : prev
      );

      // Check if all players signed and are valid
      const totalPlayers = Object.keys(match.players).length;
      const signedCount = Object.keys(updatedSigs).length;

      if (signedCount === totalPlayers) {
        const allValid = Object.values(updatedSigs).every((s) => s.valid);
        console.log("All players signed. Valid signatures:", allValid);
        if (allValid && !payoutTriggered.current) {
          payoutTriggered.current = true;
          await payoutWinner(match.winner, match.players);
        }
      }
    } catch (err) {
      console.error("❌ Signature failed", err);
    }
  };

  // Send funds from escrow to winner
  const payoutWinner = async (
    winner: string,
    players: Record<string, { address: string; name: string }>
  ) => {
    if (!escrow || !publicKey || !winner || !players[winner]) return;

    const winnerPk = new PublicKey(players[winner].address);
    const bal = await connection.getBalance(escrow.publicKey);

    console.log(`Paying out ${bal / LAMPORTS_PER_SOL} SOL to ${players[winner].name} (${winner})`);

    if (bal <= 0) {
      alert("Escrow balance is empty, cannot payout");
      return;
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: escrow.publicKey,
        toPubkey: winnerPk,
        lamports: bal - 5000, // leave 5000 lamports for fees
      })
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [escrow]);
      console.log("✅ Payout tx signature:", sig);
      alert(`Paid ${bal / LAMPORTS_PER_SOL} SOL to ${players[winner].name}`);
    } catch (e) {
      console.error("❌ Payout failed:", e);
      alert("Payout failed. Check console.");
    }
  };

  // Deposit to escrow wallet
  const depositToEscrow = async () => {
    if (!publicKey || !escrow) return alert("Connect your wallet first.");
    const lamports = parseFloat(wager) * LAMPORTS_PER_SOL;
    if (isNaN(lamports) || lamports <= 0) return alert("Invalid wager amount.");

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: escrow.publicKey,
        lamports,
      })
    );

    try {
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      alert("✅ Deposit successful!");
    } catch (err) {
      console.error("Deposit failed:", err);
      alert("❌ Deposit failed.");
    }
  };

  return (
    <div>
      <WalletMultiButton />
      <h2>🏓 Pickleball Wager</h2>

      {!lobbyCode && (
        <div>
          <div style={{ marginBottom: "1rem" }}>
            <strong>Create Lobby</strong>
            <br />
            <input
              placeholder="Your Name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              style={{ marginRight: "0.5rem" }}
            />
            <button onClick={createLobby} disabled={loading}>Create Lobby</button>
          </div>

          <div>
            <strong>Join Lobby</strong>
            <br />
            <input
              placeholder="Your Name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              style={{ marginRight: "0.5rem", marginTop: "0.5rem" }}
            />
            <input
              placeholder="Enter lobby code"
              value={joiningCode}
              onChange={(e) => setJoiningCode(e.target.value)}
              style={{ marginRight: "0.5rem", marginTop: "0.5rem" }}
            />
            <button onClick={joinLobby} disabled={loading}>Join Lobby</button>
          </div>
        </div>
      )}

      {lobbyCode && match && (
        <div>
          <h3>
            Lobby: {lobbyCode} &nbsp;
            <small style={{ fontSize: "0.8rem", color: "#666" }}>
              (Escrow Wallet: {match.escrow.pub})
            </small>
          </h3>

          <div>
            <strong>Players:</strong>
            <ul>
              {Object.entries(match.players).map(([key, p]) => (
                <li key={key}>
                  {p.name} ({p.address})
                </li>
              ))}
            </ul>
          </div>

          {!match.winner && (
            <div>
              <input
                placeholder="Enter final score"
                value={score}
                onChange={(e) => setScore(e.target.value)}
              />
              <div>
                <button onClick={() => prepMessage("A1")} disabled={loading || !match.players["A1"]}>
                  {match.players["A1"]?.name} Wins
                </button>
                <button onClick={() => prepMessage("B1")} disabled={loading || !match.players["B1"]}>
                  {match.players["B1"]?.name} Wins
                </button>
              </div>
            </div>
          )}

          {match.winner && (
            <div>
              <p>Winner: {match.players[match.winner]?.name}</p>
              <p>Score: {match.score}</p>
              <p>Message: {match.message}</p>

              {/* Show sign button only if current player hasn't signed yet */}
              {!match.signatures[yourPlayerKey || ""] && (
                <button onClick={signMessageForPlayer} disabled={loading}>
                  Sign Confirmation
                </button>
              )}

              {/* Show signatures */}
              <div>
                <strong>Signatures:</strong>
                <ul>
                  {Object.entries(match.signatures).map(([key, sig]) => (
                    <li key={key}>
                      {match.players[key]?.name}: {sig.valid ? "✅ Valid" : "❌ Invalid"}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div>
            <input
              type="number"
              step="0.01"
              placeholder="Wager Amount (SOL)"
              value={wager}
              onChange={(e) => setWager(e.target.value)}
            />
            <button onClick={depositToEscrow}>
              Deposit {wager || "?"} SOL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

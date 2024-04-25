import fs from "fs";
import dgram from "dgram";
import http from "http";
import path from "path";

console.log("The server has been started!");

let last_timestamp = Date.now();

import dotenv from "dotenv";
dotenv.config();

enum NetworkMessageType {
  RandomMatchmakingBegin = "random_matchmaking_begin",
  RandomMatchmakingCancel = "random_matchmaking_cancel",
  RandomMatchmakingCancelConfirmation = "random_matchmaking_cancel_confirmation",
  RandomMatchmakingConfirmation = "random_matchmaking_confirmation",
  RandomMatchmakingFound = "random_matchmaking_found",
  HolepunchingBegin = "holepunching_begin",
  HolepunchingCancel = "holepunching_cancel",
  HolepunchingCancelConfirmation = "holepunching_cancel_confirmation",
  HolepunchingConfirmation = "holepunching_confirmation",
  HolepunchingFound = "holepunching_found",
  PrivateLobbyReserve = "private_lobby_reserve",
  PrivateLobbyReserveConfirmation = "private_lobby_reserve_confirmation",
  PrivateLobbyCodeTaken = "private_lobby_code_taken",
  PrivateLobbyIsSelf = "private_lobby_is_self",
  PrivateLobbyFind = "private_lobby_find",
  PrivateLobbyFree = "private_lobby_free",
  PrivateLobbyFound = "private_lobby_found",
  PrivateLobbyRequest = "private_lobby_request",
  PrivateLobbyNotFound = "private_lobby_not_found",
  PrivateLobbyFreeConfirmation = "private_lobby_free_confirmation",
  FetchNews = "fetch_news",
  News = "news",
  IncorrectVersion = "incorrect_version",
}

interface ServerKeys {
  random_matchmaking: string;
  private_lobby: string;
}

interface HolepunchData {
  timestamp: number;
  ip: string;
  port: number;
}

interface StatsLog {
  total_matches: number;
  total_holepunches_expired: number;
  total_lobbies_expired: number;
  sent_packets: number;
  received_packets: number;
  invalid_packets: number;
  invalid_typed_packets: number;
}

// Main server configuration object
class ServerConfig {
  match_id_counter: number = 0;
  supported_game_versions: string[] = ["1.0.0"];
  server_keys: ServerKeys = {
    random_matchmaking: process.env.RANDOM_MATCHMAKING_KEY || "",
    private_lobby: process.env.PRIVATE_LOBBY_KEY || "",
  };
  random_matchmaking_limit: number = 2;
  holepunching_pairs_limit: number = 1000;
  private_lobby_limit: number = 500;
  random_matchmaking_inactive_timer: number = 7;
  holepunching_pairs_inactive_timer: number = 7;
  private_lobby_inactive_timer: number = 600;
  logging_interval: number = 14400; //3600;
  log_connected_ips: boolean = false;
  udp_port: number = 63567;
  latest_version: string = "1.0.0";
  news: string = "There is no news or announcements!";

  random_matchmaking_lists: Map<string, any[]> = new Map();
  holepunching_pairs_map: Map<string, HolepunchData> = new Map();
  private_lobby_maps: Map<string, Map<string, HolepunchData>> = new Map();
  matches_log: any[] = [];
  debug_log: string[] = [];
  error_log: string[] = [];
  stats_log: StatsLog = {
    total_matches: 0,
    total_holepunches_expired: 0,
    total_lobbies_expired: 0,
    sent_packets: 0,
    received_packets: 0,
    invalid_packets: 0,
    invalid_typed_packets: 0,
  };

  constructor() {
    // Ensure the environment variables are set
    if (
      !this.server_keys.random_matchmaking ||
      !this.server_keys.private_lobby
    ) {
      console.error("Server keys are not set in the environment variables.");
      process.exit(1);
    }
  }
}

const server = new ServerConfig();

//Load stats from file
var old_stats = load_file("./logs/stats_log.json");
if (old_stats != null) {
  server.stats_log = old_stats;
}

//Configurations - load from the file
var config = load_file("config.json");
if (config != null) {
  //Only override the values that are in the config object
  const __server: any = server;
  for (const [key, value] of Object.entries(config)) {
    __server[key] = value;
  }
}

//Create the random matchmaking / private lobby data structures for each version
for (let i = 0; i < server.supported_game_versions.length; i++) {
  let version = server.supported_game_versions[i];
  if (!version) {
    continue;
  }
  console.log("Creating data structures for version", version);
  server.random_matchmaking_lists.set(version, []);
  server.private_lobby_maps.set(version, new Map());
}

// Start a simple HTTP server to serve log files
const httpServer = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Basic routing to serve log files
  const filePath = path.join(__dirname, "logs", path.basename(req.url));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server error");
      }
      return;
    }

    // Determine the content type by file extension
    let contentType = "text/plain";
    if (filePath.endsWith(".json")) {
      contentType = "application/json";
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

// Set the HTTP server port
const HTTP_PORT = 8080; // You can choose any available port

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP server is running on http://localhost:${HTTP_PORT}/`);
  server.debug_log.push(
    `HTTP server is running on http://localhost:${HTTP_PORT}/`
  );
});

//Starting the server
const socket = dgram.createSocket("udp4");
socket.bind(server.udp_port);
socket.on("listening", () => {
  const address = socket.address();
  server.debug_log.push(
    `The socket is now listening to ${address.address}:${address.port}`
  );
});

//Receiving packets
socket.on("message", (msg_buffer: Buffer, rinfo: any) => {
  try {
    server.stats_log.received_packets++;
    //Get the different parts of the message
    let msg: any = JSON.parse(msg_buffer.toString());
    let version = msg.version;
    let keys = msg.keys;
    let type = msg.type;
    let data = msg.data;
    let ip = rinfo.address;
    let port = rinfo.port;

    //Check to make sure the packet is the correct format
    if (
      version === undefined ||
      keys === undefined ||
      type === undefined ||
      data === undefined
    ) {
      server.stats_log.invalid_packets++;
      throw "Invalid packet";
    }

    //IF the version is incorrect, send a message back to the player
    if (!server.supported_game_versions.includes(version)) {
      network_send(
        NetworkMessageType.IncorrectVersion,
        `Your game's version (${version}) is not supported by the matchmaking server.`,
        rinfo.address,
        rinfo.port
      );
      return;
    }

    //Get the correct data structures for the version
    let random_matchmaking_list = server.random_matchmaking_lists.get(version);
    let private_lobby_map = server.private_lobby_maps.get(version);

    if (!random_matchmaking_list || !private_lobby_map) {
      return;
    }

    //Update the timestamp
    let last_timestamp = Date.now();

    //Check the packet type, and send back a response
    switch (type) {
      case NetworkMessageType.RandomMatchmakingBegin:
        //If the key is incorrect, ignore the packet completely
        if (keys.random_matchmaking != server.server_keys.random_matchmaking) {
          return;
        }
        //Clean the matchmaking list
        random_matchmaking_list_clean(version);
        //Check if the player is already in the list or not
        let already_listed = false;
        let player_index: number | undefined = undefined;
        for (let i = 0; i < random_matchmaking_list.length; i++) {
          let player = random_matchmaking_list[i];
          if (ip == player.ip && port == player.port) {
            already_listed = true;
            player_index = i;
            break;
          }
        }
        if (already_listed && player_index != undefined) {
          //Update the timestamp
          random_matchmaking_list[player_index].timestamp = last_timestamp;
          //Send back confirmation
          network_send(
            NetworkMessageType.RandomMatchmakingConfirmation,
            "Already in the list",
            ip,
            port
          );
        } else {
          //Add the player's match ID, ip, and port to the matchmaking list
          if (
            random_matchmaking_list.length < server.random_matchmaking_limit
          ) {
            random_matchmaking_list.push({
              timestamp: last_timestamp,
              ip: ip,
              port: port,
            });
            //Send back confirmation
            network_send(
              NetworkMessageType.RandomMatchmakingConfirmation,
              "Added to the list",
              ip,
              port
            );
          } else {
            //Matchmaking list is somehow full. This should never happen
            server.error_log.push(
              `Matchmaking list is full: ${random_matchmaking_list.length}`
            );
          }
        }
        //Match pairs of players and send them a match_id
        while (random_matchmaking_list.length >= 2) {
          let match_id = server.match_id_counter;
          server.match_id_counter++;
          //Send a packet back to the first two players in the list
          network_send(
            NetworkMessageType.RandomMatchmakingFound,
            match_id,
            random_matchmaking_list[0].ip,
            random_matchmaking_list[0].port
          );
          network_send(
            NetworkMessageType.RandomMatchmakingFound,
            match_id,
            random_matchmaking_list[1].ip,
            random_matchmaking_list[1].port
          );
          //Logging
          if (server.log_connected_ips) {
            server.matches_log.push({
              match_id: match_id,
              ip1: random_matchmaking_list[0].ip,
              ip2: random_matchmaking_list[1].ip,
            });
          }
          server.stats_log.total_matches++;
          //Remove players from the list
          random_matchmaking_list.splice(0, 2);
        }
        break;
      case NetworkMessageType.RandomMatchmakingCancel:
        //If the key is incorrect, ignore the packet completely
        if (keys.random_matchmaking != server.server_keys.random_matchmaking) {
          return;
        }
        //Remove all elements in the list with the same ip and port (in case the player was accidentally added multiple times)
        for (let i = 0; i < random_matchmaking_list.length; i++) {
          let player = random_matchmaking_list[i];
          if (ip == player.ip && port == player.port) {
            random_matchmaking_list.splice(i, 1);
            i--;
          }
        }
        //Send back cancel confirmation
        network_send(
          NetworkMessageType.RandomMatchmakingCancelConfirmation,
          "Removed from the list",
          ip,
          port
        );
        break;
      case NetworkMessageType.HolepunchingBegin:
        //If the key is incorrect, ignore the packet completely
        if (keys.random_matchmaking != server.server_keys.random_matchmaking) {
          return;
        }
        //Clean the holepunching pairs map
        holepunching_pairs_map_clean();
        //Check if someone already has the match id in the map
        if (server.holepunching_pairs_map.has(data)) {
          //Compare the ip and port to see if it is a different player or not
          let holepunch_data = server.holepunching_pairs_map.get(data);
          if (!holepunch_data) {
            return;
          }
          if (ip == holepunch_data.ip && port == holepunch_data.port) {
            //The player is already waiting in the holepunching map.
            //Update the timestamp
            holepunch_data.timestamp = last_timestamp;
            //Send back confirmation
            network_send(
              NetworkMessageType.HolepunchingConfirmation,
              "Already in the map.",
              ip,
              port
            );
          } else {
            //There is a different player in the holepunching map
            //Send both players each other's ip address and port
            //One player is designated as the "host/leader" player
            network_send(
              NetworkMessageType.HolepunchingFound,
              JSON.stringify({
                ip: holepunch_data.ip,
                port: holepunch_data.port,
                is_leader: true,
              }),
              ip,
              port
            );
            network_send(
              NetworkMessageType.HolepunchingFound,
              JSON.stringify({ ip: ip, port: port, is_leader: false }),
              holepunch_data.ip,
              holepunch_data.port
            );
          }
        } else {
          //Add the player's match ID, ip, and port to the holepunching map
          if (
            server.holepunching_pairs_map.size < server.holepunching_pairs_limit
          ) {
            server.holepunching_pairs_map.set(data, {
              timestamp: last_timestamp,
              ip: ip,
              port: port,
            });
            //Send back confirmation
            network_send(
              NetworkMessageType.HolepunchingConfirmation,
              "Added to the map.",
              ip,
              port
            );
          } else {
            //Too many playeres are already holepunching
            server.error_log.push(
              `Holepunching map is full: ${server.holepunching_pairs_map.size}`
            );
          }
        }
        break;
      case NetworkMessageType.HolepunchingCancel:
        //If the key is incorrect, ignore the packet completely
        if (keys.random_matchmaking != server.server_keys.random_matchmaking) {
          return;
        }
        //Remove element with the given match_id from the map
        server.holepunching_pairs_map.delete(data);
        //Send back cancel confirmation
        network_send(
          NetworkMessageType.HolepunchingCancelConfirmation,
          "Removed from the list",
          ip,
          port
        );
        break;
      case NetworkMessageType.PrivateLobbyReserve:
        //If the key is incorrect, ignore the packet completely
        if (keys.private_lobby != server.server_keys.private_lobby) {
          return;
        }
        //Clean the private lobby map
        private_lobby_map_clean(version);
        //Check if someone already has the code in the map
        if (private_lobby_map.has(data)) {
          //Compare the ip and port to see if it is a different player or not
          let lobby_data = private_lobby_map.get(data);
          if (!lobby_data) {
            return;
          }
          if (ip == lobby_data.ip && port == lobby_data.port) {
            //The player has already reserved the lobby code
            //Update the timestamp
            lobby_data.timestamp = last_timestamp;
            //Send back confirmation
            network_send(
              NetworkMessageType.PrivateLobbyReserveConfirmation,
              "Already in the map!",
              ip,
              port
            );
          } else {
            //Someone already reserved the code
            network_send(
              NetworkMessageType.PrivateLobbyCodeTaken,
              "The code " + data + " has already been reserved.",
              ip,
              port
            );
          }
        } else {
          //Free any other lobbies that the player has reserved
          let removed: any[] = [];
          for (let [key, val] of private_lobby_map) {
            if (ip == val.ip && port == val.port) {
              private_lobby_map.delete(key);
              removed.push(key);
            }
          }
          //Add the player's code, ip, and port to the private lobby map
          if (private_lobby_map.size < server.private_lobby_limit) {
            private_lobby_map.set(data, {
              timestamp: last_timestamp,
              ip: ip,
              port: port,
            });
            //Send back confirmation
            network_send(
              NetworkMessageType.PrivateLobbyReserveConfirmation,
              "Added " + data + " to the map; Removed " + removed,
              ip,
              port
            );
          } else {
            //Too many playeres are already reserving lobbies
            server.error_log.push(
              `Private lobby map is full: ${private_lobby_map.size}`
            );
          }
        }
        break;
      case NetworkMessageType.PrivateLobbyFind:
        //If the key is incorrect, ignore the packet completely
        if (keys.private_lobby != server.server_keys.private_lobby) {
          return;
        }
        //Clean the private lobby map
        private_lobby_map_clean(version);
        //Check if someone already has the code in the map
        if (private_lobby_map.has(data)) {
          //Compare the ip and port to see if it is a different player or not
          let lobby_data = private_lobby_map.get(data);
          if (!lobby_data) {
            return;
          }
          if (ip == lobby_data.ip && port == lobby_data.port) {
            //You can't join your own lobby
            network_send(
              NetworkMessageType.PrivateLobbyIsSelf,
              "You can't join your own lobby!",
              ip,
              port
            );
          } else {
            //There is a different player in the private lobby map
            //Send both players each other's ip address and port
            network_send(
              NetworkMessageType.PrivateLobbyFound,
              JSON.stringify({ ip: lobby_data.ip, port: lobby_data.port }),
              ip,
              port
            );
            network_send(
              NetworkMessageType.PrivateLobbyRequest,
              JSON.stringify({ ip: ip, port: port }),
              lobby_data.ip,
              lobby_data.port
            );
          }
        } else {
          //No lobby with the given code exists
          network_send(
            NetworkMessageType.PrivateLobbyNotFound,
            "No lobby with the code " + data + " exists.",
            ip,
            port
          );
        }
        break;
      case NetworkMessageType.PrivateLobbyFree:
        //If the key is incorrect, ignore the packet completely
        if (keys.private_lobby != server.server_keys.private_lobby) {
          return;
        }
        //Free all lobbies reserved by the player.
        let removed: any = [];
        for (let [key, val] of private_lobby_map) {
          if (ip == val.ip && port == val.port) {
            private_lobby_map.delete(key);
            removed.push(key);
          }
        }
        //Send back confirmation
        network_send(
          NetworkMessageType.PrivateLobbyFreeConfirmation,
          "Removed " + removed + " from the list",
          ip,
          port
        );
        break;
      case NetworkMessageType.FetchNews:
        //Send back the news string, unless the game is on an older version
        if (data != server.latest_version) {
          network_send(
            NetworkMessageType.News,
            "A new version of Bear Bash is available! (" +
              server.latest_version +
              ")",
            ip,
            port
          );
        } else {
          network_send(NetworkMessageType.News, server.news, ip, port);
        }
        break;
      default:
        //Invalid message type; don't do anything.
        server.stats_log.invalid_typed_packets++;
        break;
    }
  } catch (error) {
    server.error_log.push(error);
  }
});

//Save logging files
setInterval(() => {
  //console.log("Saving log files...");
  last_timestamp = Date.now();

  if (server.matches_log.length > 0) {
    save_file(
      server.matches_log,
      "./logs/matches_log (" + last_timestamp + ").json"
    );
  }
  server.matches_log = [];

  if (server.debug_log.length > 0) {
    save_file(
      server.debug_log,
      "./logs/debug_log (" + last_timestamp + ").json"
    );
  }
  server.debug_log = [];

  if (server.error_log.length > 0) {
    save_file(
      server.error_log,
      "./logs/error_log (" + last_timestamp + ").json"
    );
  }
  server.error_log = [];

  save_file(server.stats_log, "./logs/stats_log.json");
}, server.logging_interval * 1000);

/*
Removes all elements in the random matchmaking list for the given version that are too old
*/
function random_matchmaking_list_clean(version: string) {
  last_timestamp = Date.now();
  //let number_cleaned = 0;
  let random_matchmaking_list = server.random_matchmaking_lists.get(version);
  if (!random_matchmaking_list) {
    return;
  }
  for (let i = 0; i < random_matchmaking_list.length; i++) {
    let player = random_matchmaking_list[i];
    if (
      timestamp_difference(last_timestamp, player.timestamp) >
      server.random_matchmaking_inactive_timer
    ) {
      random_matchmaking_list.splice(i, 1);
      i--;
      //number_cleaned++;
    }
  }
  //debug_log.push("Cleaned out", number_cleaned, "players from the random matchmaking list!");
}
/*
Removes all elements in the holepunching map for the given version that are too old
*/
function holepunching_pairs_map_clean() {
  last_timestamp = Date.now();
  let number_cleaned = 0;
  for (let [key, val] of server.holepunching_pairs_map) {
    if (
      timestamp_difference(last_timestamp, val.timestamp) >
      server.holepunching_pairs_inactive_timer
    ) {
      server.holepunching_pairs_map.delete(key);
      number_cleaned++;
    }
  }
  server.stats_log.total_holepunches_expired += number_cleaned;
}
/*
Removes all elements in the private lobby map that are too old
*/
function private_lobby_map_clean(version: string) {
  last_timestamp = Date.now();
  let number_cleaned = 0;
  let private_lobby_map = server.private_lobby_maps.get(version);
  if (!private_lobby_map) {
    return;
  }
  for (let [key, val] of private_lobby_map) {
    if (
      timestamp_difference(last_timestamp, val.timestamp) >
      server.private_lobby_inactive_timer
    ) {
      private_lobby_map.delete(key);
      number_cleaned++;
    }
  }
  server.stats_log.total_lobbies_expired += number_cleaned;
}

/*
Sends a message with the type and data through the socket to the given ip and port.
*/
function network_send(
  type: NetworkMessageType,
  data: any,
  ip: string,
  port: number
) {
  try {
    socket.send(JSON.stringify({ type: type, data: data }), port, ip);
    server.stats_log.sent_packets++;
    return true;
  } catch (error) {
    server.error_log.push(error);
    return false;
  }
}

//Timestamp functions
/*
Returns the difference between two timestamps in seconds rounded down.
*/
function timestamp_difference(time1: number, time2: number) {
  return Math.floor(Math.abs(time1 - time2) / 1000);
}

//File handling functions
/*
Attempts to save the given data as JSON in the specified file.
*/
function save_file(data: any, filename: string) {
  try {
    fs.writeFileSync(filename, JSON.stringify(data));
    return true;
  } catch (error) {
    server.error_log.push(error);
    return false;
  }
}

/*
Attempts to load data from the specified file. If the data cannot be loaded for any reason, null is returned.
*/
function load_file(filename: string) {
  try {
    return JSON.parse(fs.readFileSync(filename).toString());
  } catch (error) {
    server.error_log.push(error);
    return null;
  }
}

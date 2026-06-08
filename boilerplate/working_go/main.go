package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
)

var activeConnections = make(map[string]map[string]*websocket.Conn)
var activeConnectionsMu sync.Mutex
var signalingInFlight = make(map[string]bool)

type ZoomWebhookPayload struct {
	Event   string                 `json:"event"`
	Payload map[string]interface{} `json:"payload"`
}

func generateSignature(clientID, meetingUUID, streamID, clientSecret string) string {
	message := fmt.Sprintf("%s,%s,%s", clientID, meetingUUID, streamID)
	mac := hmac.New(sha256.New, []byte(clientSecret))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

func connectToMediaWebSocket(mediaURL, meetingUUID, streamID, clientID, clientSecret string, signalingConn *websocket.Conn) {
	log.Printf("Connecting to media WebSocket at %s", mediaURL)
	ws, _, err := websocket.DefaultDialer.Dial(mediaURL, nil)
	if err != nil {
		log.Printf("Error connecting to media WS: %v", err)
		return
	}
	activeConnectionsMu.Lock()
	if _, ok := activeConnections[streamID]; !ok {
		activeConnections[streamID] = make(map[string]*websocket.Conn)
	}
	activeConnections[streamID]["media"] = ws
	activeConnectionsMu.Unlock()

	signature := generateSignature(clientID, meetingUUID, streamID, clientSecret)
	handshake := map[string]interface{}{
		"msg_type":           3,
		"protocol_version":   1,
		"meeting_uuid":       meetingUUID,
		"rtms_stream_id":     streamID,
		"signature":          signature,
		"media_type":         32,
		"payload_encryption": false,
		"media_params": map[string]interface{}{
			"audio": map[string]interface{}{
				"content_type": 2,
				"sample_rate":  1,
				"channel":      1,
				"codec":        1,
				"data_opt":     1,
				"send_rate":    100,
			},
			"video": map[string]interface{}{
				"content_type": 3,
				"codec":        7,
				"resolution":   2,
				"fps":          25,
			},
		},
	}
	ws.WriteJSON(handshake)

	go func() {
		defer ws.Close()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				log.Printf("Media WS read error: %v", err)
				break
			}

			//log.Printf("Received message from media WebSocket: %s", msg)

			var parsed map[string]interface{}
			if err := json.Unmarshal(msg, &parsed); err != nil {
				log.Printf("Failed to parse message: %v", err)
				continue
			}

			msgTypeFloat, ok := parsed["msg_type"].(float64)
			if !ok {
				log.Println("Invalid or missing msg_type")
				continue
			}
			msgType := int(msgTypeFloat)

			switch msgType {
			case 4:
				if statusCode, ok := parsed["status_code"].(float64); ok && int(statusCode) == 0 {
					signalingConn.WriteJSON(map[string]interface{}{
						"msg_type":       7,
						"rtms_stream_id": streamID,
					})
					log.Println("Media handshake successful, sent start streaming request")
				}
			case 12:
				timestamp := parsed["timestamp"]
				ws.WriteJSON(map[string]interface{}{
					"msg_type":  13,
					"timestamp": timestamp,
				})
				log.Println("Responded to Media KEEP_ALIVE_REQ")
			case 14:
				log.Println("Received AUDIO data:")
				//jsonMsg, _ := json.MarshalIndent(parsed, "", "  ")
				//log.Println(string(jsonMsg))
			case 15:
				log.Println("Received VIDEO data:")
				//jsonMsg, _ := json.MarshalIndent(parsed, "", "  ")
				//log.Println(string(jsonMsg))
			case 17:
				log.Println("Received TRANSCRIPT data:")
				//jsonMsg, _ := json.MarshalIndent(parsed, "", "  ")
				//log.Println(string(jsonMsg))
			default:
				log.Printf("Unhandled msg_type: %d", msgType)
			}
		}
	}()

}

func connectToSignalingWebSocket(serverURL, meetingUUID, streamID, clientID, clientSecret string) {
	activeConnectionsMu.Lock()
	if signalingInFlight[streamID] {
		activeConnectionsMu.Unlock()
		log.Printf("Duplicate signaling handshake blocked for stream %s", streamID)
		return
	}
	if conns, ok := activeConnections[streamID]; ok && conns["signaling"] != nil {
		activeConnectionsMu.Unlock()
		log.Printf("Active signaling socket already exists for stream %s", streamID)
		return
	}
	signalingInFlight[streamID] = true
	activeConnectionsMu.Unlock()

	log.Printf("Connecting to signaling WebSocket at %s", serverURL)
	ws, _, err := websocket.DefaultDialer.Dial(serverURL, nil)
	if err != nil {
		activeConnectionsMu.Lock()
		delete(signalingInFlight, streamID)
		activeConnectionsMu.Unlock()
		log.Printf("Error connecting to signaling WS: %v", err)
		return
	}
	activeConnectionsMu.Lock()
	if _, ok := activeConnections[streamID]; !ok {
		activeConnections[streamID] = make(map[string]*websocket.Conn)
	}
	activeConnections[streamID]["signaling"] = ws
	activeConnectionsMu.Unlock()

	signature := generateSignature(clientID, meetingUUID, streamID, clientSecret)
	handshake := map[string]interface{}{
		"msg_type":         1,
		"protocol_version": 1,
		"meeting_uuid":     meetingUUID,
		"rtms_stream_id":   streamID,
		"sequence":         rand.Intn(1e9),
		"signature":        signature,
		"buffer_data":      false,
	}
	ws.WriteJSON(handshake)

	go func() {
		defer ws.Close()
		defer func() {
			activeConnectionsMu.Lock()
			delete(signalingInFlight, streamID)
			if conns, ok := activeConnections[streamID]; ok {
				delete(conns, "signaling")
				if len(conns) == 0 {
					delete(activeConnections, streamID)
				}
			}
			activeConnectionsMu.Unlock()
		}()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				log.Printf("Signaling WS read error: %v", err)
				break
			}
			var parsed map[string]interface{}
			json.Unmarshal(msg, &parsed)
			log.Printf("Signaling Message: %s", msg)

			switch int(parsed["msg_type"].(float64)) {
			case 2:
				activeConnectionsMu.Lock()
				delete(signalingInFlight, streamID)
				activeConnectionsMu.Unlock()
				if parsed["status_code"].(float64) == 0 {
					mediaURL := parsed["media_server"].(map[string]interface{})["server_urls"].(map[string]interface{})["all"].(string)
					connectToMediaWebSocket(mediaURL, meetingUUID, streamID, clientID, clientSecret, ws)
				} else {
					log.Printf("Signaling handshake failed for stream %s: status=%v reason=%v", streamID, parsed["status_code"], parsed["reason"])
				}
			case 12:
				ws.WriteJSON(map[string]interface{}{
					"msg_type":  13,
					"timestamp": parsed["timestamp"],
				})
			}
		}
	}()
}

func webhookHandler(clientID, clientSecret, zoomToken string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := ioutil.ReadAll(r.Body)
		var payload ZoomWebhookPayload
		json.Unmarshal(body, &payload)

		log.Printf("Received webhook: %s", string(body))
		event := payload.Event
		data := payload.Payload

		if event == "endpoint.url_validation" {
			plainToken := data["plainToken"].(string)
			hash := hmac.New(sha256.New, []byte(zoomToken))
			hash.Write([]byte(plainToken))
			encrypted := hex.EncodeToString(hash.Sum(nil))
			resp := map[string]string{
				"plainToken":     plainToken,
				"encryptedToken": encrypted,
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}

		if event == "meeting.rtms_started" {
			meetingUUID := data["meeting_uuid"].(string)
			streamID := data["rtms_stream_id"].(string)
			serverURL := data["server_urls"].(string)
			connectToSignalingWebSocket(serverURL, meetingUUID, streamID, clientID, clientSecret)
		}

		if event == "meeting.rtms_stopped" {
			streamID := data["rtms_stream_id"].(string)
			activeConnectionsMu.Lock()
			delete(signalingInFlight, streamID)
			conns, ok := activeConnections[streamID]
			if ok {
				for _, conn := range conns {
					conn.Close()
				}
				delete(activeConnections, streamID)
			}
			activeConnectionsMu.Unlock()
		}

		w.WriteHeader(http.StatusOK)
	}
}

func main() {
	godotenv.Load()

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	zoomToken := os.Getenv("ZOOM_SECRET_TOKEN")
	clientID := os.Getenv("ZOOM_CLIENT_ID")
	clientSecret := os.Getenv("ZOOM_CLIENT_SECRET")
	webhookPath := os.Getenv("WEBHOOK_PATH")
	if webhookPath == "" {
		webhookPath = "/"
	}

	http.HandleFunc(webhookPath, webhookHandler(clientID, clientSecret, zoomToken))

	log.Printf("Listening on :%s, webhook path: %s", port, webhookPath)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}

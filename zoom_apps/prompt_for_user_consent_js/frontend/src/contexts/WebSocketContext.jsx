import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const WebSocketContext = createContext(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within WebSocketProvider');
  }
  return context;
};

export const WebSocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [meetingRoomJoined, setMeetingRoomJoined] = useState(false);
  const socketRef = useRef(null);
  const desiredJoinRef = useRef(null);

  useEffect(() => {
    const backendUrl = window.location.origin;

    const newSocket = io(backendUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.3,
      secure: window.location.protocol === 'https:'
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('WebSocket connected');
      setIsConnected(true);

      // Re-join meeting room automatically after reconnect
      if (desiredJoinRef.current) {
        newSocket.emit('join_meeting', desiredJoinRef.current, (ack) => {
          if (ack?.ok) {
            setMeetingRoomJoined(true);
          }
        });
      }
    });

    newSocket.on('disconnect', () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
      setMeetingRoomJoined(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      setIsConnected(false);
    });

    newSocket.on('join_error', (err) => {
      console.error('Failed to join meeting room:', err);
      setMeetingRoomJoined(false);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  const joinMeetingRoom = useCallback((meetingId, zoomAppContext = null) => {
    if (!meetingId) return;
    const payload = { meetingId, ...(zoomAppContext ? { zoomAppContext } : {}) };
    desiredJoinRef.current = payload;

    const activeSocket = socketRef.current;
    if (activeSocket && activeSocket.connected && !meetingRoomJoined) {
      activeSocket.emit('join_meeting', payload, (ack) => {
        if (!ack || ack.ok) {
          setMeetingRoomJoined(true);
        }
      });
    }
  }, [meetingRoomJoined]);

  const value = {
    socket,
    isConnected,
    joinMeetingRoom,
    meetingRoomJoined
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
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

  useEffect(() => {
    // Connect to same origin as page (works with both ngrok and localhost)
    // When loaded via ngrok, connects to ngrok
    // When loaded locally, connects to localhost
    const backendUrl = window.location.origin;

    console.log('Connecting to WebSocket server at:', backendUrl);
    const newSocket = io(backendUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      secure: window.location.protocol === 'https:'
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    // Connection event handlers
    newSocket.on('connect', () => {
      console.log('WebSocket connected');
      setIsConnected(true);
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

    // Cleanup on unmount
    return () => {
      console.log('Cleaning up WebSocket connection');
      newSocket.close();
    };
  }, []);

  // Function to join meeting room
  const joinMeetingRoom = (meetingId) => {
    if (socket && isConnected && !meetingRoomJoined) {
      console.log(`📡 Joining WebSocket room for meeting: ${meetingId}`);
      socket.emit('join_meeting', meetingId);
      setMeetingRoomJoined(true);
    }
  };

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

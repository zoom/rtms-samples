import React from 'react';
import { Navbar, Container, Badge } from 'react-bootstrap';

function Header({ isHost, runningContext }) {
  return (
    <Navbar bg="primary" variant="dark" className="App-header">
      <Container>
        <Navbar.Brand>
          RTMS Consent Manager
        </Navbar.Brand>
        <Navbar.Text>
          <Badge bg={isHost ? 'success' : 'secondary'} className="me-2">
            {isHost ? 'Host' : 'Guest'}
          </Badge>
          <Badge bg="info">
            {runningContext === 'inMeeting' ? 'In Meeting' : 'Main Client'}
          </Badge>
        </Navbar.Text>
      </Container>
    </Navbar>
  );
}

export default Header;

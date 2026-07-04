# Quick Start Guide

## 1. Start the Backend Server

Navigate to the backend directory and start the server:

```bash
cd backend
chmod +x start.sh
./start.sh
```

Or manually:

```bash
cd backend
npm install
node server.js
```

The server will start on `http://localhost:3000`

## 2. Access the Application

Open your browser and navigate to:

```
http://localhost:3000
```

## 3. Upload a Contract

1. Select your role (Investor, Legal, PM, or HR)
2. Drag and drop a PDF or DOCX file, or click to browse
3. Wait for the AI analysis to complete (2-3 seconds)

## 4. Explore Different Views

Once a contract is analyzed, navigate between views using the top navigation:

- **Upload View**: Upload new contracts and see recent documents
- **Investor View**: Financial exposure and risk analysis
- **Legal View**: Compliance checks and legal implications
- **PM View**: Deliverables, timelines, and action items
- **AI Chat**: Ask questions about the contract

## 5. Chat with AI Assistant

Navigate to the AI Chat view to:
- Ask questions about contract clauses
- Get role-specific insights
- Receive citation-backed responses
- Use quick question buttons for common queries

## API Testing

You can also test the API directly:

### Health Check
```bash
curl http://localhost:3000/api/health
```

### Get All Contracts
```bash
curl http://localhost:3000/api/contracts
```

### Upload a Contract
```bash
curl -X POST http://localhost:3000/api/contracts/upload \
  -F "file=@contract.pdf" \
  -F "role=Legal"
```

### Get Contract Analysis
```bash
curl http://localhost:3000/api/contracts/{contract-id}/analysis
```

### Chat with AI
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"contractId":"{id}","message":"What are the IP rights?","role":"Legal"}'
```

## Troubleshooting

### Port Already in Use
If port 3000 is already in use:
```bash
# Find and kill the process
lsof -ti:3000 | xargs kill -9

# Or change the port in server.js:
const PORT = process.env.PORT || 3001;
```

### Dependencies Not Found
```bash
cd backend
rm -rf node_modules package-lock.json
npm install
```

### File Upload Issues
- Ensure file is PDF or DOCX format
- File size must be under 50MB
- Check that the `uploads/` directory exists

## Next Steps

1. **Integrate Real AI**: Replace mock analysis in `backend/server.js` with actual AI service calls
2. **Add Database**: Replace in-memory storage with PostgreSQL or MongoDB
3. **Add Authentication**: Implement user login and session management
4. **Deploy**: Deploy to a cloud platform (AWS, GCP, Azure)

## Support

For detailed documentation, see [README.md](README.md)

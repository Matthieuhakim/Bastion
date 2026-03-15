# Bastion SDK (Python)

Python client for the Bastion trust proxy.

## Installation

```bash
pip install bastion-sdk
```

## Usage

```python
from bastion_sdk import BastionClient

client = BastionClient(base_url="http://localhost:3000", api_key="your-key")
print(client.health())
```
